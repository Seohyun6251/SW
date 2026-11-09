require('dotenv').config(); // .env 설정 읽기
const session = require('express-session'); // 세션 도구 불러오기

const db = require('./db');
const scheduler = require('./scheduler');           // MySQL 연결 불러오기
const bcrypt = require('bcryptjs');   // 비밀번호 해시 도구 불러오기

const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 // 로그인 상태를 최대 1일 유지
    }
}));
app.use(express.static(__dirname));

const dayIndexes = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

function formatLocalDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getCurrentWeekDates(todayDate) {
    const monday = new Date(todayDate);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + index);
        return formatLocalDate(date);
    });
}

function getScheduleContext(subjects, weeklySlots, now = new Date()) {
    const todayDate = new Date(now);
    todayDate.setHours(0, 0, 0, 0);
    const today = formatLocalDate(todayDate);
    const weekDates = getCurrentWeekDates(todayDate);
    const latestExamDate = subjects.reduce(
        (latest, subject) => subject.exam_date > latest ? subject.exam_date : latest,
        subjects[0].exam_date
    );
    const availableSlots = weeklySlots
        .filter((slot) => weekDates[dayIndexes[slot.day_of_week]] <= latestExamDate)
        .map((slot) => ({
            studyDate: weekDates[dayIndexes[slot.day_of_week]],
            startHour: Number(slot.start_hour)
        }));
    const currentHour = now.getHours();
    const futureSlots = availableSlots.filter((slot) =>
        slot.studyDate > today || (slot.studyDate === today && slot.startHour > currentHour)
    );

    return {
        today,
        todayDate,
        currentHour,
        weekDates,
        // 주간 배정 우선순위는 이번 주 안에서 월요일 기준으로 고정합니다.
        priorityDate: weekDates[0],
        availableSlots,
        futureSlots
    };
}

function toSchedulerSubjects(subjects, { clearTemporaryBonus = false } = {}) {
    return subjects.map((subject) => ({
        id: Number(subject.id),
        name: subject.name,
        examDate: subject.exam_date,
        importance: Number(subject.importance),
        studyNeed: Number(subject.study_need),
        temporaryNeedBonus: clearTemporaryBonus ? 0 : Number(subject.temporary_need_bonus),
        permanentNeedBonus: Number(subject.permanent_need_bonus)
    }));
}

async function replaceFutureSchedule(connection, userId, today, currentHour, schedule) {
    await connection.execute(
        `DELETE FROM scheduled_study_slots
         WHERE user_id = ?
           AND (study_date > ? OR (study_date = ? AND start_hour > ?))`,
        [userId, today, today, currentHour]
    );
    if (schedule.length > 0) {
        const rows = schedule.map((item) => [
            userId,
            item.studyDate,
            item.startHour,
            item.subjectId,
            item.subjectName
        ]);
        await connection.query(
            `INSERT INTO scheduled_study_slots
                (user_id, study_date, start_hour, subject_id, subject_name)
             VALUES ?`,
            [rows]
        );
    }
}

async function getSavedWeekSchedule(userId, weekDates) {
    const [rows] = await db.execute(
        `SELECT DATE_FORMAT(study_date, '%Y-%m-%d') AS study_date,
                start_hour, subject_id, subject_name
         FROM scheduled_study_slots
         WHERE user_id = ? AND study_date BETWEEN ? AND ?
         ORDER BY study_date, start_hour`,
        [userId, weekDates[0], weekDates[6]]
    );
    return rows.map((row) => ({
        studyDate: row.study_date,
        startHour: Number(row.start_hour),
        subjectId: Number(row.subject_id),
        subjectName: row.subject_name
    }));
}

function hasPassed(slot, context) {
    return slot.studyDate < context.today ||
        (slot.studyDate === context.today && slot.startHour <= context.currentHour);
}

async function ensurePastScheduleSnapshot(userId, subjects, context) {
    let savedSchedule = await getSavedWeekSchedule(userId, context.weekDates);
    const savedKeys = new Set(savedSchedule.map((item) => `${item.studyDate}_${item.startHour}`));
    const missingPastSlots = context.availableSlots.filter((slot) =>
        hasPassed(slot, context) && !savedKeys.has(`${slot.studyDate}_${slot.startHour}`)
    );
    if (missingPastSlots.length === 0) return savedSchedule;

    // 기존 버전은 주 전체를 한 번에 배치했으므로 같은 규칙으로 누락된 과거 칸을 복원합니다.
    const schedulerSubjects = toSchedulerSubjects(subjects);
    const reconstructed = scheduler.makeLegacySchedule(
        schedulerSubjects,
        context.availableSlots,
        context.priorityDate
    ).schedule.filter((item) =>
        hasPassed(item, context) && !savedKeys.has(`${item.studyDate}_${item.startHour}`)
    );

    if (reconstructed.length > 0) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const rows = reconstructed.map((item) => [
                userId,
                item.studyDate,
                item.startHour,
                item.subjectId,
                item.subjectName
            ]);
            await connection.query(
                `INSERT IGNORE INTO scheduled_study_slots
                    (user_id, study_date, start_hour, subject_id, subject_name)
                 VALUES ?`,
                [rows]
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
        savedSchedule = await getSavedWeekSchedule(userId, context.weekDates);
    }

    return savedSchedule;
}

function getFixedSchedule(schedule, context) {
    return schedule.filter((item) => hasPassed(item, context));
}
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({
            message: '아이디와 비밀번호를 입력해 주세요.'
        });
    }

    try {
        const [users] = await db.execute(
            'SELECT id, username, password_hash FROM users WHERE username = ?',
            [username]
        );
        if (users.length === 0) {
            return res.status(401).json({
                message: '아이디 또는 비밀번호가 올바르지 않습니다.'
            });
        }

        const user = users[0];
        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                message: '아이디 또는 비밀번호가 올바르지 않습니다.'
            });
        }

        req.session.userId = user.id;

        req.session.save((error) => {
            if (error) {
                console.error('세션 저장 오류:', error.message);
                return res.status(500).json({
                    message: '로그인 상태 저장에 실패했습니다.'
                });
            }

            return res.json({
                message: `${user.username}님, 로그인에 성공했습니다.`
            });
        });
    } catch (error) {
        console.error('로그인 처리 오류:', error.message);

        return res.status(500).json({
            message: '로그인 중 오류가 발생했습니다.'
        });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error('로그아웃 처리 오류:', error.message);
            return res.status(500).json({ message: '로그아웃하지 못했습니다.' });
        }
        res.clearCookie('connect.sid');
        return res.json({ message: '로그아웃했습니다.' });
    });
});

app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({
            message: '아이디와 비밀번호를 입력해 주세요.'
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        await db.execute(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, passwordHash]
        );

        return res.json({
            message: '회원가입이 완료됐습니다.'
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: '이미 사용 중인 아이디입니다.'
            });
        }
        console.error('회원가입 처리 오류:', error.message);

        return res.status(500).json({
            message: '회원가입 중 오류가 발생했습니다.'
        });
    }
});
app.post('/api/subjects', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    const { name, examDate } = req.body;
    const studyNeed = Number(req.body.studyNeed);
    const importance = Number(req.body.importance);
    if (
        !name ||
        !examDate ||
        !Number.isInteger(studyNeed) ||
        studyNeed < 0 ||
        studyNeed > 100 ||
        !Number.isInteger(importance) ||
        importance < 1 ||
        importance > 5
    ) {
        return res.status(400).json({
            message: '과목명, 시험 날짜, 필요도(0~100), 중요도(1~5)를 확인해 주세요.'
        });
    }

    try {
        await db.execute(
            `INSERT INTO subjects
                (user_id, name, exam_date, study_need, importance)
             VALUES (?, ?, ?, ?, ?)`,
            [
                req.session.userId,
                name.trim(),
                examDate,
                studyNeed,
                importance
            ]
        );

        return res.status(201).json({
            message: '과목이 저장됐습니다.'
        });
    } catch (error) {
        console.error('과목 저장 오류:', error.message);

        return res.status(500).json({
            message: '과목 저장 중 오류가 발생했습니다.'
        });
    }
});
app.post('/api/study-slots', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    const { slots } = req.body;
    const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

    if (!Array.isArray(slots) || slots.length === 0) {
        return res.status(400).json({
            message: '공부할 수 있는 시간을 하나 이상 선택해 주세요.'
        });
    }
    const parsedSlots = [];

    for (const slot of slots) {
        const match = /^([a-z]{3})_(\d{1,2})$/.exec(slot);

        if (!match) {
            return res.status(400).json({
                message: '시간표 선택 형식이 올바르지 않습니다.'
            });
        }

        const day = match[1];
        const hour = Number(match[2]);

        if (!validDays.includes(day) || hour < 9 || hour > 21) {
            return res.status(400).json({
                message: '요일 또는 시간이 올바르지 않습니다.'
            });
        }

        parsedSlots.push([day, hour]);
    }

    if (new Set(parsedSlots.map(([day, hour]) => `${day}_${hour}`)).size !== parsedSlots.length) {
        return res.status(400).json({
            message: '같은 시간 칸이 중복 선택됐습니다.'
        });
    }

    let subjectCount;
    try {
        const [[countRow]] = await db.execute(
            'SELECT COUNT(*) AS subjectCount FROM subjects WHERE user_id = ?',
            [req.session.userId]
        );
        subjectCount = Number(countRow.subjectCount);
    } catch (error) {
        console.error('과목 수 확인 오류:', error.message);
        return res.status(500).json({
            message: '과목 수를 확인하지 못했습니다.'
        });
    }

    if (subjectCount === 0) {
        return res.status(400).json({
            message: '먼저 과목을 하나 이상 등록해 주세요.'
        });
    }

    if (parsedSlots.length < subjectCount) {
        return res.status(400).json({
            message: `공부 가능 시간(${parsedSlots.length}시간)이 과목 수(${subjectCount}개)보다 적습니다.`
        });
    }
    let connection;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        await connection.execute(
            'DELETE FROM study_slots WHERE user_id = ?',
            [req.session.userId]
        );

        const rows = parsedSlots.map(([day, hour]) => [
            req.session.userId,
            day,
            hour
        ]);

        await connection.query(
            'INSERT INTO study_slots (user_id, day_of_week, start_hour) VALUES ?',
            [rows]
        );

        await connection.commit();

        return res.json({
            message: '주간 공부 가능 시간이 저장됐습니다.'
        });
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        console.error('시간표 저장 오류:', error.message);

        return res.status(500).json({
            message: '시간표 저장 중 오류가 발생했습니다.'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});
app.get('/api/subjects', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    try {
        const [subjects] = await db.execute(
            `SELECT id, name,
                    DATE_FORMAT(exam_date, '%Y-%m-%d') AS exam_date,
                    study_need, importance,
                    temporary_need_bonus, permanent_need_bonus
             FROM subjects
             WHERE user_id = ?
             ORDER BY exam_date`,
            [req.session.userId]
        );

        return res.json(subjects);
    } catch (error) {
        console.error('과목 조회 오류:', error.message);
        return res.status(500).json({
            message: '과목을 불러오지 못했습니다.'
        });
    }
});
app.delete('/api/subjects/:id', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    const subjectId = Number(req.params.id);

    if (!Number.isInteger(subjectId)) {
        return res.status(400).json({
            message: '과목 번호가 올바르지 않습니다.'
        });
    }

    try {
        const [result] = await db.execute(
            'DELETE FROM subjects WHERE id = ? AND user_id = ?',
            [subjectId, req.session.userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: '과목을 찾을 수 없습니다.'
            });
        }

        return res.json({
            message: '과목을 삭제했습니다.'
        });
    } catch (error) {
        console.error('과목 삭제 오류:', error.message);
        return res.status(500).json({
            message: '과목을 삭제하지 못했습니다.'
        });
    }
});

app.post('/api/schedule/complete-makeup', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: '먼저 로그인해 주세요.' });
    }

    try {
        let subjects;
        let weeklySlots;
        [subjects] = await db.execute(
            `SELECT id, name,
                    DATE_FORMAT(exam_date, '%Y-%m-%d') AS exam_date,
                    study_need, importance,
                    temporary_need_bonus, permanent_need_bonus
             FROM subjects WHERE user_id = ? ORDER BY exam_date`,
            [req.session.userId]
        );
        [weeklySlots] = await db.execute(
            `SELECT day_of_week, start_hour FROM study_slots
             WHERE user_id = ?
             ORDER BY FIELD(day_of_week, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'), start_hour`,
            [req.session.userId]
        );
        if (subjects.length === 0 || weeklySlots.length === 0) {
            return res.status(400).json({ message: '과목과 공부 가능 시간을 먼저 등록해 주세요.' });
        }
        const context = getScheduleContext(subjects, weeklySlots);
        const schedulerSubjects = toSchedulerSubjects(subjects);
        const actualWeekSchedule = await ensurePastScheduleSnapshot(
            req.session.userId,
            subjects,
            context
        );
        const fixedSchedule = getFixedSchedule(actualWeekSchedule, context);
        const result = scheduler.completeMakeup(
            schedulerSubjects,
            context.futureSlots.length,
            context.priorityDate,
            actualWeekSchedule
        );
        if (!result.hasPendingMakeup) {
            return res.status(409).json({ message: '현재 보충이 필요한 과목이 없습니다.' });
        }
        const futureSchedule = scheduler.makeSchedule(
            result.subjects,
            context.futureSlots,
            context.today,
            fixedSchedule,
            context.priorityDate,
            context.availableSlots.length
        ).schedule;

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const subject of result.subjects) {
                await connection.execute(
                    `UPDATE subjects
                     SET temporary_need_bonus = 0, permanent_need_bonus = ?
                     WHERE id = ? AND user_id = ?`,
                    [subject.permanentNeedBonus, subject.id, req.session.userId]
                );
            }
            await replaceFutureSchedule(
                connection,
                req.session.userId,
                context.today,
                context.currentHour,
                futureSchedule
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        return res.json({
            message: '임시 필요도를 되돌리고 시간 손해를 반영했습니다.',
            lostHours: result.lostHours
        });
    } catch (error) {
        console.error('보충 완료 처리 오류:', error.message);
        return res.status(500).json({ message: error.message || '보충 완료 처리를 하지 못했습니다.' });
    }
});

app.post('/api/schedule/replan', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: '먼저 로그인해 주세요.' });
    }

    const requests = req.body.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ message: '보충할 과목과 시간을 입력해 주세요.' });
    }

    const normalizedRequests = requests.map((request) => ({
        subjectId: Number(request.subjectId),
        hours: Number(request.hours)
    }));
    if (normalizedRequests.some(({ subjectId, hours }) =>
        !Number.isInteger(subjectId) || subjectId < 1 || !Number.isInteger(hours) || hours < 1
    )) {
        return res.status(400).json({ message: '과목과 보충 시간은 올바른 정수여야 합니다.' });
    }
    if (new Set(normalizedRequests.map(({ subjectId }) => subjectId)).size !== normalizedRequests.length) {
        return res.status(400).json({ message: '같은 과목을 중복 입력했습니다.' });
    }

    let subjects;
    let weeklySlots;
    try {
        [subjects] = await db.execute(
            `SELECT id, name,
                    DATE_FORMAT(exam_date, '%Y-%m-%d') AS exam_date,
                    study_need, importance,
                    temporary_need_bonus, permanent_need_bonus
             FROM subjects WHERE user_id = ? ORDER BY exam_date`,
            [req.session.userId]
        );
        [weeklySlots] = await db.execute(
            `SELECT day_of_week, start_hour FROM study_slots
             WHERE user_id = ?
             ORDER BY FIELD(day_of_week, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'), start_hour`,
            [req.session.userId]
        );
    } catch (error) {
        console.error('시간표 재계산 자료 조회 오류:', error.message);
        return res.status(500).json({ message: '과목 또는 공부 가능 시간을 불러오지 못했습니다.' });
    }

    if (subjects.length === 0 || weeklySlots.length === 0) {
        return res.status(400).json({ message: '과목과 공부 가능 시간을 먼저 등록해 주세요.' });
    }
    if (normalizedRequests.some(({ subjectId }) => !subjects.some((subject) => Number(subject.id) === subjectId))) {
        return res.status(404).json({ message: '선택한 과목을 찾을 수 없습니다.' });
    }

    const context = getScheduleContext(subjects, weeklySlots);
    let schedulerSubjects = toSchedulerSubjects(subjects, { clearTemporaryBonus: true });

    try {
        const today = context.today;
        const slotCount = context.futureSlots.length;
        const savedSchedule = await ensurePastScheduleSnapshot(
            req.session.userId,
            subjects,
            context
        );
        const fixedSchedule = getFixedSchedule(savedSchedule, context);
        const baseline = scheduler.distributeFutureSlots(
            schedulerSubjects,
            slotCount,
            context.priorityDate,
            fixedSchedule,
            context.availableSlots.length
        );
        const goals = new Map(normalizedRequests.map((request) => {
            const current = baseline.find((subject) => subject.id === request.subjectId);
            return [request.subjectId, current.allocatedSlots + request.hours];
        }));
        const totalGoal = [...goals.values()].reduce((sum, value) => sum + value, 0);
        if (totalGoal > slotCount) {
            throw new Error('앞으로 남은 공부 시간에 입력한 보충 시간을 모두 배정할 수 없습니다.');
        }

        // 한 과목의 필요도를 높이면 다른 선택 과목의 배정도 달라질 수 있어,
        // 요청한 모든 과목이 목표 시간을 받을 때까지 순서대로 다시 계산합니다.
        let attempts = 0;
        while (attempts < 1000) {
            const allocations = scheduler.distributeFutureSlots(
                schedulerSubjects,
                slotCount,
                context.priorityDate,
                fixedSchedule,
                context.availableSlots.length
            );
            const pending = normalizedRequests.filter((request) => {
                const allocated = allocations.find((subject) => subject.id === request.subjectId).allocatedSlots;
                return allocated < goals.get(request.subjectId);
            });
            if (pending.length === 0) break;

            for (const request of pending) {
                const current = scheduler.distributeFutureSlots(
                    schedulerSubjects,
                    slotCount,
                    context.priorityDate,
                    fixedSchedule,
                    context.availableSlots.length
                )
                    .find((subject) => subject.id === request.subjectId);
                const needed = goals.get(request.subjectId) - current.allocatedSlots;
                const result = scheduler.findTemporaryNeedBonus(
                    schedulerSubjects,
                    slotCount,
                    context.priorityDate,
                    request.subjectId,
                    needed,
                    fixedSchedule,
                    context.availableSlots.length
                );
                schedulerSubjects = result.subjects;
                attempts++;
                if (attempts >= 1000) break;
            }
        }

        const finalAllocations = scheduler.distributeFutureSlots(
            schedulerSubjects,
            slotCount,
            context.priorityDate,
            fixedSchedule,
            context.availableSlots.length
        );
        if (normalizedRequests.some((request) =>
            finalAllocations.find((subject) => subject.id === request.subjectId).allocatedSlots < goals.get(request.subjectId)
        )) {
            throw new Error('입력한 보충 시간을 모두 반영할 우선순위를 계산하지 못했습니다. 과목을 나누어 시간표를 조정해 주세요.');
        }

        const changes = normalizedRequests.map((request) => {
            const current = schedulerSubjects.find((subject) => subject.id === request.subjectId);
            return {
                subjectName: current.name,
                hours: request.hours,
                temporaryNeedBonus: current.temporaryNeedBonus
            };
        });

        // 실제 시간표 배치까지 가능한지 확인한 뒤에만 임시 필요도를 저장합니다.
        const futureSchedule = slotCount > 0
            ? scheduler.makeSchedule(
                schedulerSubjects,
                context.futureSlots,
                today,
                fixedSchedule,
                context.priorityDate,
                context.availableSlots.length
            ).schedule
            : [];

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const subject of schedulerSubjects) {
                await connection.execute(
                    `UPDATE subjects SET temporary_need_bonus = ?
                     WHERE id = ? AND user_id = ?`,
                    [subject.temporaryNeedBonus, subject.id, req.session.userId]
                );
            }
            await replaceFutureSchedule(
                connection,
                req.session.userId,
                context.today,
                context.currentHour,
                futureSchedule
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        return res.json({ message: '시간표를 다시 계산했습니다.', changes });
    } catch (error) {
        console.error('시간표 재계산 오류:', error.message);
        return res.status(400).json({ message: error.message || '시간표를 다시 계산하지 못했습니다.' });
    }
});

app.get('/api/study-slots', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    try {
        const [slots] = await db.execute(
            `SELECT day_of_week, start_hour
             FROM study_slots
             WHERE user_id = ?
             ORDER BY FIELD(day_of_week, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'),
                      start_hour`,
            [req.session.userId]
        );

        return res.json(slots);
    } catch (error) {
        console.error('공부 가능 시간 조회 오류:', error.message);
        return res.status(500).json({
            message: '공부 가능 시간을 불러오지 못했습니다.'
        });
    }
});
app.get('/api/schedule', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: '먼저 로그인해 주세요.' });
    }

    try {
        const [subjects] = await db.execute(
            `SELECT id, name,
                    DATE_FORMAT(exam_date, '%Y-%m-%d') AS exam_date,
                    study_need, importance,
                    temporary_need_bonus, permanent_need_bonus
             FROM subjects
             WHERE user_id = ?
             ORDER BY exam_date`,
            [req.session.userId]
        );

        const [weeklySlots] = await db.execute(
            `SELECT day_of_week, start_hour
             FROM study_slots
             WHERE user_id = ?
             ORDER BY FIELD(day_of_week, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'),
                      start_hour`,
            [req.session.userId]
        );
        if (subjects.length === 0) {
            return res.status(400).json({ message: '먼저 과목을 하나 이상 등록해 주세요.' });
        }
        if (weeklySlots.length === 0) {
            return res.status(400).json({ message: '공부할 수 있는 시간을 하나 이상 선택해 주세요.' });
        }

        const context = getScheduleContext(subjects, weeklySlots);
        const schedulerSubjects = toSchedulerSubjects(subjects);
        const savedBeforeReplan = await ensurePastScheduleSnapshot(
            req.session.userId,
            subjects,
            context
        );
        const fixedSchedule = getFixedSchedule(savedBeforeReplan, context);
        const result = scheduler.makeSchedule(
            schedulerSubjects,
            context.futureSlots,
            context.today,
            fixedSchedule,
            context.priorityDate,
            context.availableSlots.length
        );

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await replaceFutureSchedule(
                connection,
                req.session.userId,
                context.today,
                context.currentHour,
                result.schedule
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        const savedSchedule = await getSavedWeekSchedule(req.session.userId, context.weekDates);
        const candidateDetailsBySlot = new Map(result.schedule.map((item) => [
            `${item.studyDate}_${item.startHour}`,
            item.candidates || []
        ]));
        const scheduleWithCandidates = savedSchedule.map((item) => ({
            ...item,
            candidates: candidateDetailsBySlot.get(`${item.studyDate}_${item.startHour}`) || []
        }));

        return res.json({
            weekDates: context.weekDates,
            totalAvailableSlots: result.allocations.reduce(
                (sum, subject) => sum + subject.allocatedSlots,
                0
            ),
            allocations: result.allocations,
            schedule: scheduleWithCandidates
        });
    } catch (error) {
        console.error('시간표 생성 오류:', error.message);
        return res.status(400).json({ message: error.message || '시간표를 만들지 못했습니다.' });
    }
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sign_up.html'));
});
app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});



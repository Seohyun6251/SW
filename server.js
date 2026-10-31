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

    let subjects;
    let weeklySlots;

    try {
        [subjects] = await db.execute(
            `SELECT id, name,
                    DATE_FORMAT(exam_date, '%Y-%m-%d') AS exam_date,
                    study_need, importance,
                    temporary_need_bonus, permanent_need_bonus
             FROM subjects
             WHERE user_id = ?
             ORDER BY exam_date`,
            [req.session.userId]
        );

        [weeklySlots] = await db.execute(
            `SELECT day_of_week, start_hour
             FROM study_slots
             WHERE user_id = ?
             ORDER BY FIELD(day_of_week, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'),
                      start_hour`,
            [req.session.userId]
        );
    } catch (error) {
        console.error('시간표 자료 조회 오류:', error.message);
        return res.status(500).json({
            message: '과목 또는 공부 가능 시간을 불러오지 못했습니다.'
        });
    }

    if (subjects.length === 0) {
        return res.status(400).json({
            message: '먼저 과목을 하나 이상 등록해 주세요.'
        });
    }

    if (weeklySlots.length === 0) {
        return res.status(400).json({
            message: '공부할 수 있는 시간을 하나 이상 선택해 주세요.'
        });
    }

    const dayIndexes = {
        mon: 0,
        tue: 1,
        wed: 2,
        thu: 3,
        fri: 4,
        sat: 5,
        sun: 6
    };
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const monday = new Date(todayDate);
    const daysUntilMonday = ((8 - monday.getDay()) % 7) || 7;
    monday.setDate(monday.getDate() + daysUntilMonday);

    function formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    const weekDates = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + index);
        return formatDate(date);
    });
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

    if (availableSlots.length < subjects.length) {
        return res.status(400).json({
            message: `다음 주 시험일까지 배정 가능한 공부 시간이 과목 수(${subjects.length}개)보다 적습니다.`
        });
    }

    const schedulerSubjects = subjects.map((subject) => ({
        id: Number(subject.id),
        name: subject.name,
        examDate: subject.exam_date,
        importance: Number(subject.importance),
        studyNeed: Number(subject.study_need),
        temporaryNeedBonus: Number(subject.temporary_need_bonus),
        permanentNeedBonus: Number(subject.permanent_need_bonus)
    }));

    try {
        const result = scheduler.makeSchedule(
            schedulerSubjects,
            availableSlots,
            formatDate(todayDate)
        );

        return res.json({
            weekDates,
            totalAvailableSlots: availableSlots.length,
            allocations: result.allocations,
            schedule: result.schedule
        });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sign_up.html'));
});
app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});



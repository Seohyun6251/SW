// Express 서버와 웹페이지 파일을 제공하는 데 필요한 도구를 불러옵니다.
require('dotenv').config(); // .env 설정 읽기
const session = require('express-session'); // 세션 도구 불러오기

const db = require('./db');           // MySQL 연결 불러오기
const bcrypt = require('bcryptjs');   // 비밀번호 해시 도구 불러오기

const express = require('express');
const path = require('path');

// 서버 앱을 만듭니다.
const app = express();
const PORT = 3000;

// JSON 형식으로 온 요청 내용을 읽을 수 있게 합니다.
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

// 같은 폴더의 HTML 파일들을 브라우저에 보여줄 수 있게 합니다.
app.use(express.static(__dirname));

// 로그인 버튼이 보낸 요청을 받습니다.
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    // 아이디와 비밀번호가 비어 있는지 확인
    if (!username || !password) {
        return res.status(400).json({
            message: '아이디와 비밀번호를 입력해 주세요.'
        });
    }

    try {
        // 입력한 아이디에 해당하는 사용자 정보를 DB에서 찾습니다.
        const [users] = await db.execute(
            'SELECT id, username, password_hash FROM users WHERE username = ?',
            [username]
        );

        // 해당 아이디가 없으면 로그인 실패
        if (users.length === 0) {
            return res.status(401).json({
                message: '아이디 또는 비밀번호가 올바르지 않습니다.'
            });
        }

        const user = users[0];

        // 입력한 비밀번호와 DB에 저장된 해시를 비교합니다.
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

app.get('/api/me', (req, res) => {
    if (!req.session.userId) {
        return res.json({ loggedIn: false });
    }

    return res.json({
        loggedIn: true,
        userId: req.session.userId
    });
});

// 회원가입 버튼이 보낸 요청을 받습니다.
app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;

    // 아이디와 비밀번호가 비어 있는지 확인
    if (!username || !password) {
        return res.status(400).json({
            message: '아이디와 비밀번호를 입력해 주세요.'
        });
    }

    try {
        // 비밀번호를 해시로 변환합니다. 원래 비밀번호는 DB에 저장하지 않습니다.
        const passwordHash = await bcrypt.hash(password, 10);

        // users 테이블에 아이디와 해시된 비밀번호를 저장합니다.
        await db.execute(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, passwordHash]
        );

        return res.json({
            message: '회원가입이 완료됐습니다.'
        });
    } catch (error) {
        // 이미 사용 중인 아이디라면 안내 메시지를 보냅니다.
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: '이미 사용 중인 아이디입니다.'
            });
        }

        // 비밀번호나 전체 요청 내용을 출력하지 않고 오류만 기록합니다.
        console.error('회원가입 처리 오류:', error.message);

        return res.status(500).json({
            message: '회원가입 중 오류가 발생했습니다.'
        });
    }
});

// 로그인한 사용자의 과목을 DB에 저장합니다.
app.post('/api/subjects', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: '먼저 로그인해 주세요.'
        });
    }

    const { name, examDate } = req.body;
    const studyNeed = Number(req.body.studyNeed);
    const importance = Number(req.body.importance);

    // 네 입력값이 모두 올바른지 확인합니다.
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

// 로그인한 사용자의 주간 공부 가능 시간을 저장합니다.
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

    // 예: "mon_9"를 요일 "mon", 시작 시각 9로 나눕니다.
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

    let connection;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 기존 시간표를 지우고 현재 선택된 시간으로 다시 저장합니다.
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
// 브라우저가 페이지를 찾지 못했을 때 보여줄 기본 페이지입니다.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sign_up.html'));
});

// 서버를 실행합니다.
app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
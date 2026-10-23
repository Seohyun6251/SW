// .env 파일의 설정을 읽습니다.
require('dotenv').config();

// MySQL 연결 도구를 불러옵니다.
const mysql = require('mysql2/promise');

// MySQL 연결 풀을 만듭니다.
// 이후 서버에서 이 pool을 사용해 데이터베이스에 요청합니다.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// 나중에 server.js에서 이 연결 풀을 사용할 수 있게 내보냅니다.
module.exports = pool;

// `node db.js`로 직접 실행했을 때만 접속 확인을 합니다.
if (require.main === module) {
    pool.query('SELECT 1')
        .then(() => {
            console.log('MySQL 연결 성공!');
        })
        .catch((error) => {
            console.error('MySQL 연결 실패:', error.message);
        })
        .finally(() => {
            pool.end();
        });
}
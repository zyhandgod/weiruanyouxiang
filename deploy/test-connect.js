const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
    console.log('✓ 连接成功');
    conn.exec('uname -a && cat /etc/os-release | head -5', (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => conn.end());
    });
}).on('error', err => {
    console.error('✗ 连接失败:', err.message);
    process.exit(1);
}).connect({
    host: process.env.DEPLOY_HOST,
    port: Number(process.env.DEPLOY_PORT || 22),
    username: process.env.DEPLOY_USER,
    password: process.env.DEPLOY_PASSWORD,
    readyTimeout: 15000,
});

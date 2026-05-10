// 自动化部署脚本
// 用法: node deploy/deploy.js
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    host: process.env.DEPLOY_HOST,
    port: Number(process.env.DEPLOY_PORT || 22),
    username: process.env.DEPLOY_USER,
    password: process.env.DEPLOY_PASSWORD,
    readyTimeout: 20000,
};

const DOMAIN = 'email.mooizz.com';
const REMOTE_DIR = '/var/www/email';
const APP_NAME = 'email-server';
const APP_PORT = 3001;
const LOCAL_ROOT = path.resolve(__dirname, '..');

// 要上传的文件
const FILES_TO_UPLOAD = [
    'index.html',
    'style.css',
    'script.js',
    'server.js',
    'logo111.png',
    'logo222.png',
];

function log(msg, type = 'info') {
    const colors = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m' };
    console.log(`${colors[type] || ''}${msg}\x1b[0m`);
}

function runCommand(conn, cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        log(`  $ ${cmd}`, 'dim');
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let stdout = '';
            let stderr = '';
            stream.on('data', d => {
                const s = d.toString();
                stdout += s;
                if (opts.showOutput !== false) process.stdout.write('\x1b[90m' + s + '\x1b[0m');
            });
            stream.stderr.on('data', d => {
                const s = d.toString();
                stderr += s;
                if (opts.showOutput !== false) process.stderr.write('\x1b[90m' + s + '\x1b[0m');
            });
            stream.on('close', (code) => {
                if (code === 0 || opts.ignoreError) {
                    resolve({ stdout, stderr, code });
                } else {
                    reject(new Error(`Command failed with code ${code}: ${cmd}\n${stderr}`));
                }
            });
        });
    });
}

function uploadFile(conn, local, remote) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            log(`  ↑ ${path.basename(local)} → ${remote}`, 'dim');
            sftp.fastPut(local, remote, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

async function main() {
    const missing = ['host', 'username', 'password'].filter(key => !CONFIG[key]);
    if (missing.length) {
        throw new Error(`Missing deploy environment variables: ${missing.map(key => `DEPLOY_${key.toUpperCase()}`).join(', ')}`);
    }

    const conn = new Client();

    await new Promise((resolve, reject) => {
        conn.on('ready', resolve);
        conn.on('error', reject);
        log(`🔌 连接服务器 ${CONFIG.host} ...`, 'info');
        conn.connect(CONFIG);
    });
    log('✓ SSH 连接成功', 'ok');

    // 1. 检测系统 & 安装依赖
    log('\n📦 检查并安装依赖（Node.js / nginx）...', 'info');
    const { stdout: osInfo } = await runCommand(conn, 'cat /etc/os-release | grep -E "^(ID|VERSION_ID)="', { showOutput: false });
    log(`  系统: ${osInfo.replace(/\n/g, ' ').trim()}`, 'dim');

    // 判断包管理器
    const { stdout: which } = await runCommand(conn, 'which apt || which yum || echo none', { showOutput: false, ignoreError: true });
    const pkgMgr = which.includes('apt') ? 'apt' : which.includes('yum') ? 'yum' : 'none';
    log(`  包管理器: ${pkgMgr}`, 'dim');

    // 安装 Node
    const { stdout: nodeVer } = await runCommand(conn, 'node -v 2>/dev/null || echo none', { showOutput: false, ignoreError: true });
    if (nodeVer.trim() === 'none') {
        log('  安装 Node.js ...', 'info');
        if (pkgMgr === 'apt') {
            await runCommand(conn, 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs');
        } else if (pkgMgr === 'yum') {
            await runCommand(conn, 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs');
        }
    } else {
        log(`  Node.js 已安装: ${nodeVer.trim()}`, 'ok');
    }

    // 安装 nginx
    const { stdout: nginxVer } = await runCommand(conn, 'nginx -v 2>&1 || echo none', { showOutput: false, ignoreError: true });
    if (nginxVer.includes('none')) {
        log('  安装 nginx ...', 'info');
        await runCommand(conn, pkgMgr === 'apt' ? 'apt-get install -y nginx' : 'yum install -y nginx');
    } else {
        log(`  nginx 已安装`, 'ok');
    }

    // 安装 pm2
    const { stdout: pm2Ver } = await runCommand(conn, 'pm2 -v 2>/dev/null || echo none', { showOutput: false, ignoreError: true });
    if (pm2Ver.trim() === 'none') {
        log('  安装 pm2 ...', 'info');
        await runCommand(conn, 'npm install -g pm2');
    } else {
        log(`  pm2 已安装: ${pm2Ver.trim()}`, 'ok');
    }

    // 2. 创建目录
    log('\n📂 准备部署目录...', 'info');
    await runCommand(conn, `mkdir -p ${REMOTE_DIR}`);

    // 3. 上传文件
    log('\n⬆️  上传文件...', 'info');
    for (const file of FILES_TO_UPLOAD) {
        const local = path.join(LOCAL_ROOT, file);
        if (!fs.existsSync(local)) {
            log(`  跳过不存在的文件: ${file}`, 'warn');
            continue;
        }
        await uploadFile(conn, local, `${REMOTE_DIR}/${file}`);
    }

    // 4. 启动服务
    log('\n🚀 启动 Node 服务...', 'info');
    await runCommand(conn, `cd ${REMOTE_DIR} && pm2 delete ${APP_NAME} 2>/dev/null || true`, { ignoreError: true });
    await runCommand(conn, `cd ${REMOTE_DIR} && PORT=${APP_PORT} pm2 start server.js --name ${APP_NAME}`);
    await runCommand(conn, `pm2 save && pm2 startup systemd -u root --hp /root | tail -1 | bash || true`, { ignoreError: true });

    // 5. 配置 nginx
    log('\n⚙️  配置 nginx 反向代理...', 'info');
    const nginxConfig = `server {
    listen 80;
    server_name ${DOMAIN};

    # Let's Encrypt 验证路径
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
`;
    // 写 nginx 配置
    const tmpConfPath = `/tmp/${DOMAIN}.conf`;
    await runCommand(conn, `cat > ${tmpConfPath} << 'EOF_NGINX_CONFIG'\n${nginxConfig}\nEOF_NGINX_CONFIG`);

    // 判断 nginx 配置路径
    const { stdout: nginxPaths } = await runCommand(conn, 'test -d /etc/nginx/conf.d && echo conf.d || test -d /etc/nginx/sites-enabled && echo sites-enabled || echo none', { showOutput: false });
    const nginxStyle = nginxPaths.trim();

    if (nginxStyle === 'conf.d') {
        await runCommand(conn, `mv ${tmpConfPath} /etc/nginx/conf.d/${DOMAIN}.conf`);
    } else if (nginxStyle === 'sites-enabled') {
        await runCommand(conn, `mv ${tmpConfPath} /etc/nginx/sites-available/${DOMAIN}`);
        await runCommand(conn, `ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}`);
    }

    await runCommand(conn, `mkdir -p /var/www/html`);
    await runCommand(conn, `nginx -t && systemctl reload nginx || service nginx reload`);
    log('  nginx 配置完成', 'ok');

    // 6. 申请 HTTPS 证书
    log('\n🔒 申请 HTTPS 证书 (Let\'s Encrypt)...', 'info');
    const { stdout: certbotVer } = await runCommand(conn, 'certbot --version 2>/dev/null || echo none', { showOutput: false, ignoreError: true });
    if (certbotVer.trim() === 'none') {
        if (pkgMgr === 'apt') {
            await runCommand(conn, 'apt-get install -y certbot python3-certbot-nginx');
        } else if (pkgMgr === 'yum') {
            await runCommand(conn, 'yum install -y certbot python3-certbot-nginx || yum install -y epel-release && yum install -y certbot python2-certbot-nginx');
        }
    }

    try {
        await runCommand(conn, `certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@${DOMAIN} --redirect`);
        log('✓ HTTPS 证书申请成功', 'ok');
    } catch (e) {
        log('⚠ HTTPS 证书申请失败（可能是 DNS 还未解析）：' + e.message.split('\n')[0], 'warn');
        log('  HTTP 访问仍然可用，稍后可手动执行：', 'warn');
        log(`  certbot --nginx -d ${DOMAIN}`, 'dim');
    }

    // 7. 放行防火墙
    log('\n🛡️  放行防火墙端口...', 'info');
    await runCommand(conn, 'ufw allow 80/tcp 2>/dev/null; ufw allow 443/tcp 2>/dev/null; firewall-cmd --permanent --add-service=http 2>/dev/null; firewall-cmd --permanent --add-service=https 2>/dev/null; firewall-cmd --reload 2>/dev/null; true', { ignoreError: true });

    log('\n✅ 部署完成！', 'ok');
    log(`   HTTP:  http://${DOMAIN}`, 'ok');
    log(`   HTTPS: https://${DOMAIN}`, 'ok');

    conn.end();
}

main().catch(err => {
    log('\n❌ 部署失败: ' + err.message, 'err');
    console.error(err);
    process.exit(1);
});

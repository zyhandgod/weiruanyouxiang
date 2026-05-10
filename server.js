// 本地代理服务器 - 转发请求到 zxc000.com 绕过 CORS
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'zxc000.com';

// MIME 类型映射
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url);

    // API 代理转发
    if (parsedUrl.pathname.startsWith('/api/')) {
        const options = {
            hostname: TARGET_HOST,
            port: 443,
            path: req.url,
            method: req.method,
            rejectUnauthorized: false, // 忽略SSL证书错误
            headers: {
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://zxc000.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                'env': '191',
                'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"'
            }
        };

        console.log(`[Proxy] ${req.method} ${req.url}`);

        const proxyReq = https.request(options, (proxyRes) => {
            // 允许跨域
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('代理错误:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '代理请求失败: ' + err.message }));
        });

        req.pipe(proxyReq);
        return;
    }

    // 处理 OPTIONS 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });
        res.end();
        return;
    }

    // 静态文件服务
    let filePath = '.' + parsedUrl.pathname;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + err.code);
            }
        } else {
            // 禁用缓存，保证刷新即拿到最新代码
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log('====================================');
    console.log(`  微软邮箱管理系统已启动`);
    console.log(`  访问地址: http://localhost:${PORT}`);
    console.log(`  API 代理: ${TARGET_HOST}`);
    console.log('====================================');
});

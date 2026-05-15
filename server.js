const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TOKEN_HOST = 'login.microsoftonline.com';
const GRAPH_HOST = 'graph.microsoft.com';
const LINGPAI_HOST = 'lingpaixitong.com';

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(data));
}

function requestJson(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
            let raw = '';
            resp.setEncoding('utf8');
            resp.on('data', chunk => { raw += chunk; });
            resp.on('end', () => {
                let data = null;
                try {
                    data = raw ? JSON.parse(raw) : null;
                } catch (err) {
                    err.message = `Invalid JSON from ${options.hostname}: ${err.message}`;
                    err.raw = raw.slice(0, 500);
                    return reject(err);
                }
                resolve({ statusCode: resp.statusCode, headers: resp.headers, data, raw });
            });
        });

        req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function exchangeRefreshToken(refreshToken, clientId) {
    const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read offline_access'
    }).toString();

    const tenants = ['consumers', 'common'];
    let lastError = null;

    for (const tenant of tenants) {
        const result = await requestJson({
            hostname: TOKEN_HOST,
            port: 443,
            path: `/${tenant}/oauth2/v2.0/token`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        }, body);

        if (result.statusCode >= 200 && result.statusCode < 300 && result.data?.access_token) {
            return result.data.access_token;
        }

        lastError = result.data || { error: `Token endpoint returned ${result.statusCode}` };
    }

    const message = lastError?.error_description || lastError?.error || 'Unable to refresh Microsoft access token';
    const err = new Error(message);
    err.details = lastError;
    throw err;
}

function normalizeMailbox(mailbox) {
    const key = String(mailbox || 'INBOX').toLowerCase();
    if (key === 'junk' || key === 'junkemail' || key === 'junk email') return 'junkemail';
    if (key === 'sent' || key === 'sentitems') return 'sentitems';
    if (key === 'draft' || key === 'drafts') return 'drafts';
    if (key === 'deleted' || key === 'deleteditems') return 'deleteditems';
    return 'inbox';
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
}

function mapGraphMessage(message) {
    const from = message.from?.emailAddress || message.sender?.emailAddress || {};
    return {
        id: message.id,
        send: from.name ? `${from.name} <${from.address || ''}>` : (from.address || ''),
        subject: message.subject || '(无主题)',
        date: formatDate(message.receivedDateTime || message.sentDateTime),
        text: message.bodyPreview || '',
        html: message.body?.content || message.bodyPreview || '',
        isRead: Boolean(message.isRead)
    };
}

async function handleMailAll(req, res, parsedUrl) {
    const refreshToken = parsedUrl.searchParams.get('refresh_token');
    const clientId = parsedUrl.searchParams.get('client_id');
    const email = parsedUrl.searchParams.get('email') || '';
    const password = parsedUrl.searchParams.get('password') || '';
    const mailboxParam = parsedUrl.searchParams.get('mailbox') || 'INBOX';

    if (!refreshToken || !clientId) {
        return sendJson(res, 400, { error: '缺少 refresh_token 或 client_id' });
    }

    const upstreamParams = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        email,
        mailbox: mailboxParam,
        response_type: parsedUrl.searchParams.get('response_type') || 'json',
        password
    });

    try {
        const upstream = await requestJson({
            hostname: LINGPAI_HOST,
            servername: LINGPAI_HOST,
            port: 443,
            path: `/api/mail-all?${upstreamParams.toString()}`,
            method: 'GET',
            rejectUnauthorized: false,
            headers: {
                'Accept': 'application/json',
                'Host': LINGPAI_HOST,
                'Referer': `https://${LINGPAI_HOST}/`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
            }
        });

        return sendJson(res, upstream.statusCode || 200, upstream.data || {});
    } catch (upstreamErr) {
        console.error('[Lingpai Mail] error:', upstreamErr.message);
        return sendJson(res, 502, {
            error: `lingpaixitong 收件接口请求失败: ${upstreamErr.message}`
        });
    }
}

function serveStatic(res, pathname) {
    const decodedPath = decodeURIComponent(pathname);
    let filePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    filePath = path.normalize(filePath);

    const absolutePath = path.resolve(ROOT, filePath);
    if (!absolutePath.startsWith(ROOT + path.sep) && absolutePath !== ROOT) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(absolutePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? 'File not found' : `Server error: ${err.code}`);
            return;
        }

        const contentType = mimeTypes[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(content);
    });
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        return sendJson(res, 204, {});
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && parsedUrl.pathname === '/api/mail-all') {
        return handleMailAll(req, res, parsedUrl);
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Unknown API endpoint' });
    }

    return serveStatic(res, parsedUrl.pathname);
});

server.listen(PORT, () => {
    console.log('====================================');
    console.log('  微软邮箱管理系统已启动');
    console.log(`  访问地址: http://localhost:${PORT}`);
    console.log('  API: Microsoft Graph');
    console.log('====================================');
});

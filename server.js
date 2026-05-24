// 本地服务：静态页面 + 微软官方收件接口
// 优先兼容当前导入的 Microsoft refresh_token：用官方 token 端点换取 IMAP OAuth token，
// 再连接 outlook.office365.com 官方 IMAP 服务读取收件/垃圾箱。
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// 注意：在部分受限环境里某些端口可能不可监听，默认用 8788（你也可以自行用 PORT 环境变量覆盖）
const PORT = process.env.PORT || 8788;

// 简单内存缓存：避免同一 refresh_token 频繁换取 access_token
// key: `${clientId}:${refreshToken.slice(0,16)}`（不存全量 refresh_token 到内存 key 里，减少误日志/误输出风险）
const tokenCache = new Map(); // { accessToken, expiresAt }
const IMAP_LIST_LIMIT = 20;

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendJson(res, statusCode, obj) {
    setCors(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function formatDateTime(dt) {
    try {
        const d = new Date(dt);
        if (Number.isNaN(d.getTime())) return String(dt || '');
        // 统一输出类似：2026/5/18 14:38:00（不带 AM/PM）
        return d.toLocaleString('zh-CN', { hour12: false });
    } catch {
        return String(dt || '');
    }
}

async function redeemRefreshToken({ tenant, clientId, refreshToken, scope }) {
    const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);
    if (scope) params.set('scope', scope);

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = json.error_description || json.error || `HTTP ${resp.status}`;
        const err = new Error(msg);
        err._ms = { tenant, status: resp.status, body: json };
        throw err;
    }
    return json; // { access_token, expires_in, ... }
}

async function redeemRefreshTokenV1({ tenant, clientId, refreshToken, resource }) {
    const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/token`;
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);
    params.set('resource', resource);

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = json.error_description || json.error || `HTTP ${resp.status}`;
        const err = new Error(msg);
        err._ms = { tenant, status: resp.status, body: json };
        throw err;
    }
    return json; // { access_token, expires_in, ... }
}

async function getImapAccessToken(clientId, refreshToken) {
    const cacheKey = `imap:${clientId}:${String(refreshToken).slice(0, 16)}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt && Date.now() < cached.expiresAt - 10_000) {
        return cached.accessToken;
    }

    const microsoftIdentityAttempts = [
        {
            endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            body: {
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
            }
        },
        {
            endpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
            body: {
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
            }
        },
    ];
    const liveAttempts = [
        {
            endpoint: 'https://login.live.com/oauth20_token.srf',
            body: {
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'service::outlook.office.com::MBI_SSL'
            }
        },
        {
            endpoint: 'https://login.live.com/oauth20_token.srf',
            body: {
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'wl.imap wl.offline_access'
            }
        },
        {
            endpoint: 'https://login.live.com/oauth20_token.srf',
            body: {
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }
        }
    ];
    const attempts = String(refreshToken).startsWith('M.')
        ? [...liveAttempts, ...microsoftIdentityAttempts]
        : [...microsoftIdentityAttempts, ...liveAttempts];

    let lastErr = null;
    for (const attempt of attempts) {
        try {
            const resp = await fetch(attempt.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(attempt.body)
            });
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok || !json.access_token) {
                throw new Error(json.error_description || json.error || `HTTP ${resp.status}`);
            }
            const expiresIn = Number(json.expires_in || 3600);
            tokenCache.set(cacheKey, {
                accessToken: json.access_token,
                expiresAt: Date.now() + expiresIn * 1000
            });
            return json.access_token;
        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('无法使用 refresh_token 换取 IMAP access_token');
}

function isJwtLike(token) {
    return typeof token === 'string' && token.split('.').length === 3;
}

async function getGraphAccessToken(clientId, refreshToken) {
    const cacheKey = `graph:${clientId}:${String(refreshToken).slice(0, 16)}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt && Date.now() < cached.expiresAt - 10_000) {
        return cached.accessToken;
    }

    // 兼容不同账号类型：先 common，失败再 organizations/consumers
    const tenants = ['common', 'organizations', 'consumers'];
    // scope 可能因发放 refresh_token 的原始授权而不同；先尝试 Graph Mail.Read
    const scopes = [
        'https://graph.microsoft.com/Mail.Read offline_access',
        'offline_access https://graph.microsoft.com/Mail.Read'
    ];

    let lastErr = null;
    for (const tenant of tenants) {
        for (const scope of scopes) {
            try {
                const token = await redeemRefreshToken({ tenant, clientId, refreshToken, scope });
                // Graph 要求 Bearer token 是 JWT。部分 refresh_token 会换出 Outlook/Live 的 opaque token，
                // 这种 token 会触发 “JWT is not well formed”，这里跳过继续尝试 v1/resource 流程。
                if (!isJwtLike(token.access_token)) {
                    lastErr = new Error('换到的 Graph access_token 不是 JWT，继续尝试其它官方 token 端点');
                    continue;
                }
                const expiresIn = Number(token.expires_in || 3600);
                tokenCache.set(cacheKey, {
                    accessToken: token.access_token,
                    expiresAt: Date.now() + expiresIn * 1000
                });
                return token.access_token;
            } catch (e) {
                lastErr = e;
                // invalid_grant（refresh_token 失效）这类错误直接 break scope 循环意义不大，但继续尝试 tenant 可能也没用；
                // 这里保持简单：继续尝试下一组合，最后统一报错。
            }
        }
    }

    // 兼容 v1 refresh_token：使用 resource 参数换 Graph token
    for (const tenant of tenants) {
        try {
            const token = await redeemRefreshTokenV1({
                tenant,
                clientId,
                refreshToken,
                resource: 'https://graph.microsoft.com/'
            });
            if (!isJwtLike(token.access_token)) {
                lastErr = new Error('v1/resource 换到的 Graph access_token 仍不是 JWT');
                continue;
            }
            const expiresIn = Number(token.expires_in || 3600);
            tokenCache.set(cacheKey, {
                accessToken: token.access_token,
                expiresAt: Date.now() + expiresIn * 1000
            });
            return token.access_token;
        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('无法使用 refresh_token 换取 access_token');
}

function decodeQuotedPrintable(input) {
    if (!input) return '';
    const normalized = String(input)
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(normalized, 'binary').toString('utf8');
}

function decodeMimeWords(str) {
    if (!str) return '';
    return String(str).replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
        try {
            if (enc.toUpperCase() === 'B') {
                return Buffer.from(text, 'base64').toString('utf8');
            }
            return decodeQuotedPrintable(text.replace(/_/g, ' '));
        } catch {
            return text;
        }
    });
}

function parseHeaders(rawHeader) {
    const headers = {};
    const lines = String(rawHeader || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
    }
    return headers;
}

function getHeaderParam(headerValue, name) {
    const re = new RegExp(`${name}="?([^";]+)"?`, 'i');
    const m = String(headerValue || '').match(re);
    return m ? m[1] : '';
}

function decodeBodyPart(content, transferEncoding) {
    const enc = String(transferEncoding || '').toLowerCase();
    if (enc.includes('base64')) {
        try {
            return Buffer.from(String(content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch {
            return String(content || '');
        }
    }
    if (enc.includes('quoted-printable')) return decodeQuotedPrintable(content);
    return String(content || '');
}

function extractBody(rawHeader, rawBody) {
    const topHeaders = parseHeaders(rawHeader);
    const contentType = topHeaders['content-type'] || '';
    const boundary = getHeaderParam(contentType, 'boundary');

    let html = '';
    let text = '';

    if (boundary) {
        const marker = `--${boundary}`;
        const parts = String(rawBody || '').split(marker).slice(1);
        for (const part of parts) {
            if (part.startsWith('--')) continue;
            const clean = part.replace(/^\r?\n/, '');
            const sepMatch = clean.match(/\r?\n\r?\n/);
            if (!sepMatch || sepMatch.index === undefined) continue;
            const partHeader = clean.slice(0, sepMatch.index);
            const partBody = clean.slice(sepMatch.index + sepMatch[0].length);
            const h = parseHeaders(partHeader);
            const ct = String(h['content-type'] || '').toLowerCase();
            const decoded = decodeBodyPart(partBody, h['content-transfer-encoding']).trim();
            if (!html && ct.includes('text/html')) html = decoded;
            if (!text && ct.includes('text/plain')) text = decoded;
        }
    } else {
        const decoded = decodeBodyPart(rawBody, topHeaders['content-transfer-encoding']).trim();
        if (String(contentType).toLowerCase().includes('text/html')) html = decoded;
        else text = decoded;
    }

    return { html, text };
}

function extractFetchLiteral(raw, fieldName) {
    const fieldPattern = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${fieldPattern}(?:<0>)?\\s*\\{(\\d+)\\}\\r?\\n`, 'i');
    const m = raw.match(re);
    if (!m) return '';
    const len = Number(m[1]);
    const start = (m.index || 0) + m[0].length;
    return raw.slice(start, start + len);
}

function extractHeaderLiteral(raw) {
    const re = /BODY\[HEADER(?:\.FIELDS[^\]]*)?\](?:<0>)?\s*\{(\d+)\}\r?\n/i;
    const m = String(raw || '').match(re);
    if (!m) return '';
    const len = Number(m[1]);
    const start = (m.index || 0) + m[0].length;
    return raw.slice(start, start + len);
}

function extractTextLiteral(raw) {
    return extractFetchLiteral(raw, 'BODY[TEXT]');
}

function splitFetchResponses(raw) {
    const text = String(raw || '');
    const matches = [...text.matchAll(/\* \d+ FETCH \(/g)];
    return matches.map((m, idx) => {
        const start = m.index || 0;
        const end = idx + 1 < matches.length ? (matches[idx + 1].index || text.length) : text.length;
        return text.slice(start, end);
    });
}

function parseUidFromFetch(block) {
    const m = String(block || '').match(/\bUID\s+(\d+)\b/i);
    return m ? m[1] : '';
}

async function fetchImapMessages({ email, accessToken, mailboxCode }) {
    const folder = String(mailboxCode || 'INBOX').toUpperCase() === 'JUNK' || String(mailboxCode) === 'Junk'
        ? 'Junk'
        : 'INBOX';

    const socket = tls.connect(993, 'outlook.office365.com', {
        servername: 'outlook.office365.com'
    });
    socket.setEncoding('utf8');

    let buffer = '';
    let tagNo = 1;

    function readUntilTag(tag, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`IMAP 请求超时：${tag}`));
            }, timeoutMs);
            function cleanup() {
                clearTimeout(timer);
                socket.off('data', onData);
                socket.off('error', onError);
            }
            function onError(err) {
                cleanup();
                reject(err);
            }
            function onData(chunk) {
                buffer += chunk;
                const ok = buffer.includes(`${tag} OK`);
                const no = buffer.includes(`${tag} NO`);
                const bad = buffer.includes(`${tag} BAD`);
                if (ok || no || bad) {
                    const out = buffer;
                    buffer = '';
                    cleanup();
                    if (ok) resolve(out);
                    else reject(new Error(out.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')));
                }
            }
            socket.on('data', onData);
            socket.on('error', onError);
        });
    }

    function command(cmd, timeoutMs) {
        const tag = `A${tagNo++}`;
        socket.write(`${tag} ${cmd}\r\n`);
        return readUntilTag(tag, timeoutMs);
    }

    try {
        await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
        });
        await new Promise((resolve) => socket.once('data', () => resolve()));

        const auth = Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
        await command(`AUTHENTICATE XOAUTH2 ${auth}`);
        await command(`SELECT "${folder}"`);
        const searchRaw = await command('UID SEARCH ALL');
        const searchLine = searchRaw.split(/\r?\n/).find(line => line.startsWith('* SEARCH')) || '';
        const uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
        const latest = uids.slice(-IMAP_LIST_LIMIT).reverse();
        if (latest.length === 0) return [];

        // 改回：列表接口直接拉取正文，保证点“查看”马上能看到邮件内容。
        // 保留 token/列表缓存和数量限制，避免每次都重复全量请求。
        const messages = [];
        for (const uid of latest) {
            const raw = await command(`UID FETCH ${uid} (UID BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.120000>)`, 60_000);
            const rawHeader = extractHeaderLiteral(raw);
            const rawBody = extractTextLiteral(raw);
            const headers = parseHeaders(rawHeader);
            const { html, text } = extractBody(rawHeader, rawBody);
            const fromRaw = decodeMimeWords(headers.from || '');
            const fromEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw;

            messages.push({
                uid,
                send: fromEmail,
                subject: decodeMimeWords(headers.subject || '(无主题)') || '(无主题)',
                date: formatDateTime(headers.date || ''),
                html,
                text: text || rawBody.slice(0, 2000)
            });
        }
        return messages;
    } finally {
        try { socket.end(); } catch {}
    }
}

async function fetchImapMessageBody({ email, accessToken, mailboxCode, uid }) {
    const folder = String(mailboxCode || 'INBOX').toUpperCase() === 'JUNK' || String(mailboxCode) === 'Junk'
        ? 'Junk'
        : 'INBOX';

    const socket = tls.connect(993, 'outlook.office365.com', {
        servername: 'outlook.office365.com'
    });
    socket.setEncoding('utf8');

    let buffer = '';
    let tagNo = 1;

    function readUntilTag(tag, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`IMAP 请求超时：${tag}`));
            }, timeoutMs);
            function cleanup() {
                clearTimeout(timer);
                socket.off('data', onData);
                socket.off('error', onError);
            }
            function onError(err) {
                cleanup();
                reject(err);
            }
            function onData(chunk) {
                buffer += chunk;
                const ok = buffer.includes(`${tag} OK`);
                const no = buffer.includes(`${tag} NO`);
                const bad = buffer.includes(`${tag} BAD`);
                if (ok || no || bad) {
                    const out = buffer;
                    buffer = '';
                    cleanup();
                    if (ok) resolve(out);
                    else reject(new Error(out.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')));
                }
            }
            socket.on('data', onData);
            socket.on('error', onError);
        });
    }

    function command(cmd, timeoutMs) {
        const tag = `A${tagNo++}`;
        socket.write(`${tag} ${cmd}\r\n`);
        return readUntilTag(tag, timeoutMs);
    }

    try {
        await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
        });
        await new Promise((resolve) => socket.once('data', () => resolve()));

        const auth = Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
        await command(`AUTHENTICATE XOAUTH2 ${auth}`);
        await command(`SELECT "${folder}"`);
        const raw = await command(`UID FETCH ${uid} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.120000>)`, 60_000);
        const rawHeader = extractHeaderLiteral(raw);
        const rawBody = extractTextLiteral(raw);
        const headers = parseHeaders(rawHeader);
        const { html, text } = extractBody(rawHeader, rawBody);
        const fromRaw = decodeMimeWords(headers.from || '');
        const fromEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw;
        return {
            uid: String(uid),
            send: fromEmail,
            subject: decodeMimeWords(headers.subject || '(无主题)') || '(无主题)',
            date: formatDateTime(headers.date || ''),
            html,
            text: text || rawBody.slice(0, 2000)
        };
    } finally {
        try { socket.end(); } catch {}
    }
}

async function fetchOfficialMessages({ clientId, refreshToken, email, mailbox }) {
    let lastErr = null;

    try {
        const graphToken = await getGraphAccessToken(clientId, refreshToken);
        return await fetchGraphMessages(graphToken, mailbox);
    } catch (e) {
        lastErr = e;
        console.warn('Graph 不可用:', e && e.message ? e.message : e);
    }

    try {
        const outlookToken = await getImapAccessToken(clientId, refreshToken);
        return await fetchOutlookRestMessages(outlookToken, mailbox);
    } catch (e) {
        lastErr = e;
        console.warn('Outlook REST 不可用:', e && e.message ? e.message : e);
    }

    if (email) {
        try {
            const imapToken = await getImapAccessToken(clientId, refreshToken);
            return await fetchImapMessages({ email, accessToken: imapToken, mailboxCode: mailbox });
        } catch (e) {
            lastErr = e;
            console.warn('IMAP 不可用:', e && e.message ? e.message : e);
        }
    }

    const msg = lastErr && lastErr.message ? lastErr.message : '微软收件接口不可用';
    throw new Error(`获取收件列表失败：${msg}`);
}

async function fetchOutlookRestMessages(accessToken, mailboxCode) {
    const key = String(mailboxCode || 'INBOX').toLowerCase();
    const folder = (key === 'junk' || key === 'junkemail' || key === 'junk email')
        ? 'JunkEmail'
        : 'Inbox';

    const apiUrl = new URL(`https://outlook.office.com/api/v2.0/me/MailFolders/${folder}/Messages`);
    apiUrl.searchParams.set('$top', String(IMAP_LIST_LIMIT));
    apiUrl.searchParams.set('$select', 'From,Subject,ReceivedDateTime,BodyPreview,Body');
    apiUrl.searchParams.set('$orderby', 'ReceivedDateTime desc');

    const resp = await fetch(apiUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
        }
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(json.error?.message || json.error || `Outlook REST 请求失败：HTTP ${resp.status}`);
    }

    const items = Array.isArray(json.value) ? json.value : [];
    return items.map(m => {
        const from = m.From?.EmailAddress || m.from?.emailAddress || {};
        const body = m.Body || m.body || {};
        const content = body.Content || body.content || '';
        const contentType = String(body.ContentType || body.contentType || '').toLowerCase();
        return {
            id: m.Id || m.id || '',
            send: from.Address || from.address || from.Name || from.name || '',
            subject: m.Subject || m.subject || '(无主题)',
            date: formatDateTime(m.ReceivedDateTime || m.receivedDateTime || ''),
            html: contentType === 'html' ? content : '',
            text: contentType === 'html' ? (m.BodyPreview || m.bodyPreview || '') : (content || m.BodyPreview || m.bodyPreview || '')
        };
    });
}

async function fetchOfficialMessageBody({ clientId, refreshToken, email, mailbox, uid }) {
    if (!email) throw new Error('IMAP 官方收件需要 email 参数');
    if (!uid) throw new Error('缺少参数：uid');
    const imapToken = await getImapAccessToken(clientId, refreshToken);
    return fetchImapMessageBody({ email, accessToken: imapToken, mailboxCode: mailbox, uid });
}

async function fetchGraphMessages(accessToken, mailboxCode) {
    // INBOX -> inbox；Junk -> junkemail（Graph 的 well-known folder）
    const folder = String(mailboxCode || 'INBOX').toUpperCase() === 'JUNK' || String(mailboxCode) === 'Junk'
        ? 'junkemail'
        : 'inbox';

    const baseUrl = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`);
    baseUrl.searchParams.set('$top', '100');
    baseUrl.searchParams.set('$orderby', 'receivedDateTime desc');
    baseUrl.searchParams.set('$select', 'sender,subject,receivedDateTime,bodyPreview,body');

    const resp = await fetch(baseUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
        }
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = json.error?.message || `Graph 请求失败：HTTP ${resp.status}`;
        const err = new Error(msg);
        err._graph = { status: resp.status, body: json };
        throw err;
    }

    const items = Array.isArray(json.value) ? json.value : [];
    return items.map(m => {
        const sender = m.sender?.emailAddress?.address || m.sender?.emailAddress?.name || '';
        const subject = m.subject || '(无主题)';
        const date = formatDateTime(m.receivedDateTime);
        const body = m.body || {};
        const preview = m.bodyPreview || '';
        const isHtml = String(body.contentType || '').toLowerCase() === 'html';
        const content = body.content || '';
        return {
            send: sender,
            subject,
            date,
            html: isHtml ? content : '',
            text: !isHtml ? (content || preview) : preview
        };
    });
}

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
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname;

    // API：/api/mail-all -> Microsoft 官方 IMAP/Graph
    if (pathname === '/api/mail-all') {
        // 处理 OPTIONS 预检
        if (req.method === 'OPTIONS') {
            setCors(res);
            res.writeHead(204);
            return res.end();
        }

        (async () => {
            try {
                const refreshToken = u.searchParams.get('refresh_token') || '';
                const clientId = u.searchParams.get('client_id') || '';
                const mailbox = u.searchParams.get('mailbox') || 'INBOX';

                if (!refreshToken || !clientId) {
                    return sendJson(res, 400, { error: '缺少参数：refresh_token / client_id' });
                }

                const clientIdShort = clientId.length > 12 ? `${clientId.slice(0, 8)}...${clientId.slice(-4)}` : clientId;
                console.log(`[MailList] mailbox=${mailbox} client_id=${clientIdShort}`);

                const list = await fetchOfficialMessages({ clientId, refreshToken, email: u.searchParams.get('email') || '', mailbox });
                return sendJson(res, 200, list);
            } catch (e) {
                console.error('Mail API 错误:', e && e.message ? e.message : e);
                const message = String(e && e.message ? e.message : e);
                const authLike = /AUTHENTICATE|401|invalid_grant|AADSTS|not enabled for consumers|client does not exist/i.test(message);
                const detail = authLike
                    ? `${message}。可能原因：refresh_token 没有 Outlook 邮件权限，或该邮箱账号未开启 IMAP。`
                    : message;
                return sendJson(res, authLike ? 401 : 500, { error: detail });
            }
        })();
        return;
    }

    // API：/api/mail-body -> 点击查看时再按 UID 拉取正文
    if (pathname === '/api/mail-body') {
        if (req.method === 'OPTIONS') {
            setCors(res);
            res.writeHead(204);
            return res.end();
        }

        (async () => {
            try {
                const refreshToken = u.searchParams.get('refresh_token') || '';
                const clientId = u.searchParams.get('client_id') || '';
                const email = u.searchParams.get('email') || '';
                const mailbox = u.searchParams.get('mailbox') || 'INBOX';
                const uid = u.searchParams.get('uid') || '';

                if (!refreshToken || !clientId || !email || !uid) {
                    return sendJson(res, 400, { error: '缺少参数：refresh_token / client_id / email / uid' });
                }

                const clientIdShort = clientId.length > 12 ? `${clientId.slice(0, 8)}...${clientId.slice(-4)}` : clientId;
                console.log(`[MailBody] mailbox=${mailbox} uid=${uid} client_id=${clientIdShort}`);

                const body = await fetchOfficialMessageBody({ clientId, refreshToken, email, mailbox, uid });
                return sendJson(res, 200, body);
            } catch (e) {
                console.error('Mail Body API 错误:', e && e.message ? e.message : e);
                return sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
            }
        })();
        return;
    }

    // 其他 /api/*：不再转发第三方，避免误用“其他项目接口”
    if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: '未知 API 路径（本地仅实现 /api/mail-all /api/mail-body，且使用 Microsoft 官方接口）' });
    }

    // 处理 OPTIONS 预检
    if (req.method === 'OPTIONS') {
        setCors(res);
        res.writeHead(204);
        res.end();
        return;
    }

    // 静态文件服务
    let filePath = '.' + pathname;
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

server.listen(PORT, '127.0.0.1', () => {
    console.log('====================================');
    console.log(`  微软邮箱管理系统已启动`);
    console.log(`  访问地址: http://localhost:${PORT}`);
    console.log(`  API: Microsoft 官方 Outlook REST/IMAP/Graph (/api/mail-all)`);
    console.log('====================================');
});

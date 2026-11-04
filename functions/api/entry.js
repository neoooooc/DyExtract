// Public share-page parser. No account cookies, signing, or private API fallbacks.
const SHARE_HOSTS = new Set(['v.douyin.com', 'douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']);
const MEDIA_DOMAINS = ['douyinvod.com', 'douyinstatic.com', 'bytecdn.cn', 'bytecdn.com', 'bytedance.com', 'zjcdn.com'];
const MAX_HTML_BYTES = 3 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 10000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

export class SafeError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'SafeError';
        this.code = code;
        this.status = status;
    }
}

function parseUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\\\u0000-\u0020\u007f]/.test(value)) {
        throw new SafeError('INVALID_URL', '链接格式不正确。');
    }
    let url;
    try { url = new URL(value); } catch { throw new SafeError('INVALID_URL', '链接格式不正确。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.endsWith('.')) {
        throw new SafeError('INVALID_URL', '仅支持不含账号信息的 HTTPS 链接。');
    }
    return url;
}

export function validateShareUrl(value) {
    const url = parseUrl(value);
    if (!SHARE_HOSTS.has(url.hostname)) throw new SafeError('UNSUPPORTED_HOST', '请使用抖音公开分享链接。');
    const short = url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]{1,100}\/?$/.test(url.pathname);
    const video = url.hostname !== 'v.douyin.com' && /^\/(?:share\/)?video\/\d{17,19}\/?$/.test(url.pathname);
    if (!short && !video) throw new SafeError('UNSUPPORTED_LINK', '目前仅支持公开单条视频分享链接。');
    return url;
}

export function validateMediaUrl(value) {
    const url = parseUrl(value);
    if (!MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
        throw new SafeError('UNSUPPORTED_MEDIA_HOST', '该下载地址不在已验证的视频域名范围内。');
    }
    return url;
}

function itemIdFromUrl(url) {
    return url.pathname.match(/^\/(?:share\/)?video\/(\d{17,19})\/?$/)?.[1] || '';
}

function shareInput(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) {
        throw new SafeError('INVALID_INPUT', '请粘贴一条抖音视频分享链接。');
    }
    const matches = text.match(/https?:\/\/[^\s<>"'，。；！]+/g) || [];
    if (matches.length !== 1) throw new SafeError('INVALID_INPUT', '请每次只提供一条视频分享链接。');
    return validateShareUrl(matches[0]);
}

function cancelBody(response) {
    return response.body?.cancel().catch(() => {});
}

async function boundedText(response) {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_HTML_BYTES)) {
        await cancelBody(response);
        throw new SafeError('PAGE_TOO_LARGE', '分享页数据超过大小限制。', 502);
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_HTML_BYTES) throw new SafeError('PAGE_TOO_LARGE', '分享页数据超过大小限制。', 502);
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
}

async function fetchPage(initialUrl, fetcher) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let url = initialUrl;
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            validateShareUrl(url.href);
            const response = await fetcher(url.href, {
                method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
                headers: { Accept: 'text/html', 'User-Agent': MOBILE_UA },
            });
            if (response.redirected) {
                await cancelBody(response);
                throw new SafeError('UNSAFE_REDIRECT', '无法安全检查分享页跳转。', 502);
            }
            if (REDIRECTS.has(response.status)) {
                const location = response.headers.get('location');
                await cancelBody(response);
                if (!location || hop === MAX_REDIRECTS) throw new SafeError('REDIRECT_LIMIT', '分享链接跳转异常。', 502);
                url = validateShareUrl(new URL(location, url).href);
                continue;
            }
            if (response.status !== 200) {
                await cancelBody(response);
                throw new SafeError('UPSTREAM_UNAVAILABLE', '公开分享页暂不可用；请在抖音中打开原链接。', 502);
            }
            if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
                await cancelBody(response);
                throw new SafeError('UNEXPECTED_PAGE', '抖音没有返回可解析的公开分享页。', 502);
            }
            return { url, html: await boundedText(response) };
        }
    } catch (error) {
        if (error instanceof SafeError) throw error;
        if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', '公开分享页请求超时，请稍后重试。', 504);
        throw new SafeError('UPSTREAM_UNAVAILABLE', '无法连接公开分享页，请稍后重试。', 502);
    } finally { clearTimeout(timer); }
}

// Read JSON as data. Never evaluate page scripts.
function embeddedData(html) {
    const match = /window\._ROUTER_DATA\s*=\s*/.exec(html);
    if (!match) throw new SafeError('PUBLIC_DATA_UNAVAILABLE', '公开分享页未提供视频数据；需要登录或验证的内容不会继续提取。', 422);
    let start = match.index + match[0].length;
    if (html[start] !== '{') throw new SafeError('PUBLIC_DATA_UNAVAILABLE', '公开分享页数据格式已变化。', 422);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < html.length; index++) {
        const char = html[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(html.slice(start, index + 1)); }
                catch { break; }
            }
        }
    }
    throw new SafeError('PUBLIC_DATA_UNAVAILABLE', '公开分享页数据格式已变化。', 422);
}

function findItem(data, expectedId) {
    const queue = [{ value: data, depth: 0 }];
    let visited = 0;
    while (queue.length) {
        const { value, depth } = queue.pop();
        if (!value || typeof value !== 'object' || depth > 24) continue;
        if (++visited > 20000) throw new SafeError('PAGE_TOO_COMPLEX', '分享页数据超过处理限制。', 422);
        const id = value.aweme_id ?? value.item_id;
        if (id !== undefined && String(id) === expectedId && value.video) return value;
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
        }
    }
    throw new SafeError('ITEM_MISMATCH', '分享页未提供与链接一致的视频，已停止提取。', 422);
}

function isTrue(value) { return value === true || value === 1; }
function isFalse(value) { return value === false || value === 0; }

function ensureDownloadAllowed(item) {
    const status = item.status || {};
    if (isTrue(item.is_private) || isTrue(status.is_private) || isTrue(status.self_see)
        || isTrue(status.is_delete) || isTrue(status.is_prohibited)
        || (status.private_status !== undefined && status.private_status !== 0)) {
        throw new SafeError('PRIVATE_OR_UNAVAILABLE', '该视频不是可公开保存的内容。', 403);
    }
    const allow = item.video_control?.allow_download;
    if (isFalse(allow)) throw new SafeError('DOWNLOAD_NOT_ALLOWED', '作者或平台未允许下载该视频。', 403);
    if (!isTrue(allow)) throw new SafeError('DOWNLOAD_PERMISSION_UNKNOWN', '无法确认平台允许下载，已停止提取。', 403);
    if (!(isFalse(status.is_private) || isFalse(item.is_private) || status.private_status === 0)) {
        throw new SafeError('PUBLIC_STATUS_UNKNOWN', '无法确认视频为公开内容，已停止提取。', 403);
    }
}

export async function parseShare(text, { fetcher = fetch } = {}) {
    const input = shareInput(text);
    const inputId = itemIdFromUrl(input);
    const initialUrl = inputId ? new URL(`https://www.iesdouyin.com/share/video/${inputId}/`) : input;
    // Tracking query values are never needed to open a public share page.
    initialUrl.search = '';
    initialUrl.hash = '';
    const { url, html } = await fetchPage(initialUrl, fetcher);
    const finalId = itemIdFromUrl(url);
    if (!finalId || (inputId && inputId !== finalId)) throw new SafeError('ITEM_MISMATCH', '分享链接跳转到了其他内容，已停止提取。', 422);
    const item = findItem(embeddedData(html), finalId);
    ensureDownloadAllowed(item);
    const urls = item.video?.download_addr?.url_list;
    if (!Array.isArray(urls) || !urls.length || typeof urls[0] !== 'string') {
        throw new SafeError('DOWNLOAD_UNAVAILABLE', '公开数据未提供下载地址；不会使用播放地址替代。', 422);
    }
    validateMediaUrl(urls[0]);
    return {
        success: true, type: 'video', item_id: finalId,
        title: String(item.desc || item.share_info?.share_title || '抖音视频').slice(0, 1000),
        author: String(item.author?.nickname || '未知作者').slice(0, 200),
        play_url: urls[0], download_url: urls[0],
        download_allowed: true, source: 'public-share', platform: 'douyin',
    };
}

export async function safeFetchMedia(value, { fetcher = fetch, range } = {}) {
    let url = validateMediaUrl(value);
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new SafeError('INVALID_RANGE', '下载范围格式不正确。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const response = await fetcher(url.href, {
                method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
                headers: { Accept: 'video/mp4,video/webm,video/quicktime', ...(range ? { Range: range } : {}) },
            });
            if (response.redirected) {
                await cancelBody(response);
                throw new SafeError('UNSAFE_REDIRECT', '无法安全检查下载跳转。', 502);
            }
            if (REDIRECTS.has(response.status)) {
                const location = response.headers.get('location');
                await cancelBody(response);
                if (!location || hop === MAX_REDIRECTS) throw new SafeError('REDIRECT_LIMIT', '下载地址跳转异常。', 502);
                url = validateMediaUrl(new URL(location, url).href);
                continue;
            }
            if (response.status !== 200 && response.status !== 206) {
                await cancelBody(response);
                throw new SafeError('MEDIA_UNAVAILABLE', '平台未提供可下载视频；不会尝试绕过限制。', 502);
            }
            if (!/^video\/(?:mp4|webm|quicktime)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
                await cancelBody(response);
                throw new SafeError('INVALID_MEDIA_TYPE', '下载地址没有返回视频文件。', 502);
            }
            const length = response.headers.get('content-length');
            const total = response.headers.get('content-range')?.match(/^bytes \d+-\d+\/(\d+)$/)?.[1];
            if (length === null || !/^\d+$/.test(length) || Number(length) <= 0) {
                await cancelBody(response);
                throw new SafeError('MEDIA_SIZE_UNKNOWN', '平台未提供可验证的文件大小，已停止下载。', 502);
            }
            if (Number(length) > MAX_MEDIA_BYTES || (total && Number(total) > MAX_MEDIA_BYTES)) {
                await cancelBody(response);
                throw new SafeError('MEDIA_TOO_LARGE', '视频超过 200 MB 下载限制。', 413);
            }
            // The caller must whitelist response headers and cap streamed bytes.
            // No body reads occur here: the download stays streamed to the caller.
            return response;
        }
    } catch (error) {
        if (error instanceof SafeError) throw error;
        if (controller.signal.aborted) throw new SafeError('UPSTREAM_TIMEOUT', '视频服务器响应超时。', 504);
        throw new SafeError('MEDIA_UNAVAILABLE', '无法连接视频服务器。', 502);
    } finally { clearTimeout(timer); }
}

export async function onRequest({request}) {
 const u=new URL(request.url), action=u.searchParams.get('action');
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 const json=(data,status=200)=>Response.json(data,{status,headers});
 if(action==='health') return json({status:'ok',mode:'public-downloads-only'});
 if(request.method!=='GET') return json({error:'仅支持 GET'},405);
 try {
  if(!['parse','video'].includes(action)) return json({error:'不支持的操作'},400);
  const input=u.searchParams.get('url')||'';
  const result=await parseShare(input);
  if(action==='parse') return json({...result,play_url:input,download_url:u.origin+'/api/entry?action=video&url='+encodeURIComponent(input)});
  const upstream=await safeFetchMedia(result.download_url,{range:request.headers.get('range')});
  const out=new Headers(headers);
  for(const key of ['content-type','content-length','content-range','accept-ranges']) if(upstream.headers.has(key)) out.set(key,upstream.headers.get(key));
  out.set('Content-Disposition','attachment; filename="douyin_'+result.item_id+'.mp4"');
  out.set('Content-Security-Policy',"default-src 'none'; sandbox");
  let size=0;
  const capped=upstream.body.pipeThrough(new TransformStream({transform(chunk,controller){size+=chunk.byteLength;if(size>MAX_MEDIA_BYTES) throw new Error('File too large');controller.enqueue(chunk);}}));
  return new Response(capped,{status:upstream.status,headers:out});
 } catch(e) {return json({success:false,error:e.message,code:e.code||'ERROR'},e.status||502);}
}

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { dispatch } from './router';
import { onRequest } from './middleware/security';
const require = createRequire(import.meta.url);
const swaggerDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
const docs = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Konektag API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`;
const server = createServer(async (incoming,outgoing) => {
  const controller = new AbortController();
  outgoing.on('close',()=>controller.abort());
  try {
    // Public origin is explicit; do not trust arbitrary forwarded host/proto headers.
    const origin = process.env.API_PUBLIC_URL || `http://${incoming.headers.host || 'localhost'}`;
    const url = new URL(incoming.url || '/',origin);
    let response: Response;
    if (url.pathname === '/livez') response = Response.json({status:'alive'});
    else if (url.pathname === '/docs' || url.pathname === '/docs/') response = new Response(docs,{headers:{'content-type':'text/html; charset=utf-8'}});
    else if (url.pathname === '/openapi.json') response = new Response(await readFile('dist/openapi.json'),{headers:{'content-type':'application/json'}});
    else if (url.pathname === '/docs/init.js') response = new Response(`const ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false,oauth2RedirectUrl:location.origin+'/docs/oauth2-redirect.html'});ui.initOAuth({clientId:'frontend-konektag',usePkceWithAuthorizationCodeGrant:true,scopes:[]});`,{headers:{'content-type':'application/javascript','cache-control':'no-store'}});
    else if (url.pathname === '/docs/oauth2-redirect.html') response = new Response(await readFile(path.join(swaggerDir,'oauth2-redirect.html')),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
    else if (['/docs/swagger-ui.css','/docs/swagger-ui-bundle.js'].includes(url.pathname)) response = new Response(await readFile(path.join(swaggerDir,path.basename(url.pathname))),{headers:{'content-type':url.pathname.endsWith('.css')?'text/css':'application/javascript'}});
    else {
      const headers = new Headers();
      for (const [key,value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(v=>headers.append(key,v));
        else if (value !== undefined) headers.set(key,value);
      }
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
      const request = new Request(url,{method:incoming.method,headers,body:hasBody?Readable.toWeb(incoming) as ReadableStream:undefined,duplex:'half',signal:controller.signal} as RequestInit);
      response = await dispatch(request,incoming.socket.remoteAddress || '',onRequest);
    }
    outgoing.statusCode = response.status;
    response.headers.forEach((value,key)=>{if(key !== 'set-cookie') outgoing.setHeader(key,value);});
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('set-cookie',cookies);
    if (incoming.method === 'HEAD' || !response.body) outgoing.end();
    else await pipeline(Readable.fromWeb(response.body as any),outgoing);
  } catch (error) {
    if (!controller.signal.aborted) console.error('[HTTP]',error instanceof Error?error.message:'Request failed');
    if (!outgoing.headersSent) { outgoing.statusCode=500;outgoing.setHeader('content-type','application/json');outgoing.end(JSON.stringify({error:'INTERNAL_SERVER_ERROR'})); }
    else outgoing.destroy();
  }
});
server.listen(Number(process.env.PORT || 3000),process.env.HOST || '0.0.0.0',()=>console.log('[HTTP] Konektag API listening'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));

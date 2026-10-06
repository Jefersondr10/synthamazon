import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startWebServer } from '../src/web/server.mjs';
import { startSalesAlertMonitor } from '../src/web/sales-alert-monitor.mjs';

function request(origin,route,{method='GET',headers={},body}={}) {
  const target=new URL(origin);
  return new Promise((resolve,reject)=>{const req=http.request({hostname:target.hostname,port:target.port,path:route,method,headers},res=>{const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{const text=Buffer.concat(parts).toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,json,text});});});req.on('error',reject);req.end(body);});
}
test('alert reads and actions enforce authentication, store scope, CSRF, input bounds and conflicts',async t=>{
  const calls=[],repository={getBootstrap:()=>({stores:[{storeId:'a'}]}),salesAlerts:input=>{calls.push(['read',input]);return{items:[],counts:{new:0}};},saveSalesAlert:input=>{calls.push(['write',input]);if(input.expectedVersion===9)throw Object.assign(new Error('changed'),{code:'REVIEW_CONFLICT'});return{state:'seen'};}};
  const app=await startWebServer({repository,rootDir:path.resolve('.'),storeScope:'a'});t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const url=new URL(app.url),origin=url.origin;
  assert.equal((await request(origin,'/api/sales-alerts')).status,403);
  const connect=await request(origin,url.pathname),cookie=connect.headers['set-cookie'][0].split(';')[0],headers={cookie};
  const boot=await request(origin,'/api/bootstrap',{headers});
  assert.equal((await request(origin,'/api/sales-alerts?storeId=all&status=seen&mode=FBA',{headers})).status,200);
  assert.equal(calls.at(-1)[1].storeId,'a');
  assert.equal((await request(origin,'/api/sales-alerts?storeId=b',{headers})).status,403);
  for(const route of ['?status=bad','?type=bad','?mode=unknown','?limit=0','?status=new&status=seen','?days=7'])assert.equal((await request(origin,'/api/sales-alerts'+route,{headers})).status,400);
  const input={id:'a'.repeat(64),storeId:'a',action:'seen',expectedVersion:1},postHeaders={cookie,origin,'content-type':'application/json','x-csrf-token':boot.json.meta.csrfToken};
  const post=(payload,extra={})=>request(origin,'/api/sales-alerts',{method:'POST',headers:{...postHeaders,...extra},body:JSON.stringify(payload)});
  assert.equal((await post(input,{'x-csrf-token':'bad'})).status,403);
  assert.equal((await post(input,{origin:'https://invalid.example'})).status,403);
  assert.equal((await post({...input,storeId:'b'})).status,403);
  assert.equal((await post({...input,action:'delete'})).status,400);
  assert.equal((await post({...input,expectedVersion:9})).status,409);
  assert.equal((await post(input)).status,200);
  for(const asset of ['/sales-alerts.js','/sales-alerts.css']){assert.equal((await request(origin,asset)).status,403);assert.equal((await request(origin,asset,{headers})).status,200);}
});
test('background analyzer never overlaps an in-flight run and stops cleanly',async()=>{
  let count=0,release;
  const pending=new Promise(resolve=>release=resolve),repository={syncSalesAlerts:async()=>{count++;await pending;}};
  const stop=startSalesAlertMonitor(repository,{intervalMs:10});
  await new Promise(resolve=>setTimeout(resolve,45));assert.equal(count,1);
  stop();release();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(count,1);
});

const webpush = require('web-push');


/* =========================================================
   Redis 設定
========================================================= */

const REDIS_URL =
process.env.UPSTASH_REDIS_REST_URL ||
process.env.KV_REST_API_URL;

const REDIS_TOKEN =
process.env.UPSTASH_REDIS_REST_TOKEN ||
process.env.KV_REST_API_TOKEN;


/* =========================================================
   Redis 指令
========================================================= */

async function redisCommand(command){

if(!REDIS_URL || !REDIS_TOKEN){

throw new Error(
'Redis 環境變數未設定'
);

}

const controller =
new AbortController();

const timer =
setTimeout(
()=>controller.abort(),
8000
);

try{

const r =
await fetch(
REDIS_URL,
{
method:'POST',

headers:{
Authorization:
`Bearer ${REDIS_TOKEN}`,

'Content-Type':
'application/json'
},

body:
JSON.stringify(command),

signal:
controller.signal
}
);

const d =
await r.json();

if(!r.ok){

throw new Error(
d.error ||
`Redis HTTP ${r.status}`
);

}

return d.result;

}
finally{

clearTimeout(timer);

}

}


/* =========================================================
   刪除失效裝置
========================================================= */

async function deleteDevice(deviceId){

const deviceKey =
`swing:push:device:${deviceId}`;

try{

await redisCommand([
'DEL',
deviceKey
]);

await redisCommand([
'SREM',
'swing:push:devices',
deviceId
]);

return true;

}
catch(e){

console.error(
'刪除舊 Push 裝置失敗',
deviceId,
e
);

return false;

}

}


/* =========================================================
   判斷 endpoint
========================================================= */

function endpointInfo(endpoint){

try{

const u =
new URL(endpoint);

const host =
u.hostname;

if(
host.includes('push.apple.com')
){

return {
type:'Apple Push',
host
};

}

if(
host.includes('fcm.googleapis.com')
){

return {
type:'FCM',
host
};

}

if(
host.includes('mozilla.com')
){

return {
type:'Mozilla Push',
host
};

}

return {
type:'Unknown',
host
};

}
catch{

return {
type:'Unknown',
host:''
};

}

}


/* =========================================================
   API
========================================================= */

module.exports =
async function handler(req,res){

try{

if(
req.method !== 'GET'
){

return res
.status(405)
.json({
ok:false,
error:'Method not allowed'
});

}


/* =========================================================
   VAPID
========================================================= */

const publicKey =
process.env.VAPID_PUBLIC_KEY;

const privateKey =
process.env.VAPID_PRIVATE_KEY;

const subject =
process.env.VAPID_SUBJECT ||
'mailto:liaozhanxie@gmail.com';


if(
!publicKey ||
!privateKey
){

return res
.status(500)
.json({
ok:false,
error:'VAPID 環境變數未設定'
});

}


webpush.setVapidDetails(
subject,
publicKey,
privateKey
);


/* =========================================================
   取得所有 Push 裝置
========================================================= */

const deviceIds =
await redisCommand([
'SMEMBERS',
'swing:push:devices'
]) || [];


if(!deviceIds.length){

return res.json({

ok:false,

sent:0,

failed:0,

deleted:0,

totalSubscriptions:0,

vapid:{
subject,
publicKeyLength:
publicKey.length,
privateKeyLength:
privateKey.length
},

message:
'目前 Redis 沒有任何 Push 訂閱'

});

}


/* =========================================================
   測試 Payload
========================================================= */

const payload =
JSON.stringify({

title:
'✅ 台股進場通知測試成功',

body:
'背景推播系統測試中。如果你看到這則通知，代表 Web Push 已成功。',

icon:
'/icon-192.png',

badge:
'/icon-192.png',

url:
'/'

});


/* =========================================================
   發送
========================================================= */

const results = [];

let sent = 0;
let failed = 0;
let deleted = 0;


for(const deviceId of deviceIds){

const key =
`swing:push:device:${deviceId}`;

let raw;

try{

raw =
await redisCommand([
'GET',
key
]);

}
catch(e){

failed++;

results.push({

deviceId,

ok:false,

stage:'redis-get',

message:
e.message

});

continue;

}


/* Redis set 有 ID，
   但 device 本體不存在 */

if(!raw){

const removed =
await deleteDevice(
deviceId
);

if(removed){
deleted++;
}

results.push({

deviceId,

ok:false,

deleted:removed,

stage:'missing-device',

message:
'裝置資料不存在，已清理 Redis 索引'

});

continue;

}


/* =========================================================
   解析裝置資料
========================================================= */

let device;

try{

device =
typeof raw === 'string'
?
JSON.parse(raw)
:
raw;

}
catch(e){

const removed =
await deleteDevice(
deviceId
);

if(removed){
deleted++;
}

results.push({

deviceId,

ok:false,

deleted:removed,

stage:'invalid-json',

message:
'裝置資料 JSON 損壞，已刪除'

});

continue;

}


const subscription =
device.subscription ||
device.pushSubscription ||
device;


if(
!subscription ||
!subscription.endpoint
){

const removed =
await deleteDevice(
deviceId
);

if(removed){
deleted++;
}

results.push({

deviceId,

ok:false,

deleted:removed,

stage:'invalid-subscription',

message:
'Push Subscription 格式錯誤，已刪除'

});

continue;

}


const info =
endpointInfo(
subscription.endpoint
);


/* =========================================================
   實際送 Push
========================================================= */

try{

const sendPromise =
webpush.sendNotification(
subscription,
payload,
{
TTL:60
}
);

const timeoutPromise =
new Promise(
(_,reject)=>
setTimeout(
()=>reject(
new Error(
'Push 發送超時'
)
),
15000
)
);

const response =
await Promise.race([
sendPromise,
timeoutPromise
]);


sent++;


results.push({

deviceId,

ok:true,

endpointType:
info.type,

endpointHost:
info.host,

statusCode:
response?.statusCode || 201

});


}
catch(e){

const statusCode =
e?.statusCode || null;

const body =
typeof e?.body === 'string'
?
e.body
:
JSON.stringify(
e?.body || ''
);


const isExpired =
statusCode === 404 ||
statusCode === 410;


/*
  Apple Push：
  subscription 是使用舊 VAPID Key 建立。

  這就是目前遇到的：
  VapidPkHashMismatch
*/

const isVapidMismatch =
statusCode === 400 &&
body.includes(
'VapidPkHashMismatch'
);


/*
  404 / 410：
  Push endpoint 已失效

  VapidPkHashMismatch：
  舊 VAPID subscription

  以上都直接從 Redis 清除。
*/

let removed = false;

if(
isExpired ||
isVapidMismatch
){

removed =
await deleteDevice(
deviceId
);

if(removed){
deleted++;
}

}


/*
  被確認為舊訂閱並成功刪除，
  不再把它算進 failed。

  這樣下一次測試就只會剩
  目前有效的新訂閱。
*/

if(!removed){

failed++;

}


results.push({

deviceId,

ok:false,

endpointType:
info.type,

endpointHost:
info.host,

statusCode,

code:
e?.code || null,

message:
e?.message ||
'Push 發送失敗',

body,

deleted:
removed,

deleteReason:
isVapidMismatch
?
'VapidPkHashMismatch'
:
isExpired
?
'Expired subscription'
:
null

});

}

}


/* =========================================================
   最終結果
========================================================= */

return res.json({

ok:
sent > 0,

sent,

failed,

deleted,

totalSubscriptions:
deviceIds.length,

remainingSubscriptions:
Math.max(
0,
deviceIds.length - deleted
),

vapid:{

subject,

publicKeyLength:
publicKey.length,

privateKeyLength:
privateKey.length

},

message:
sent > 0
?
(
deleted > 0
?
`測試通知已送出，並清除 ${deleted} 個舊訂閱`
:
'測試通知已成功送出'
)
:
(
deleted > 0
?
`沒有成功推播，但已清除 ${deleted} 個失效訂閱`
:
'找到訂閱，但所有 Push 都發送失敗'
),

results

});


}
catch(e){

console.error(
'test-push error',
e
);

return res
.status(500)
.json({

ok:false,

error:
e?.message ||
'Push 測試失敗',

stack:
process.env.NODE_ENV === 'development'
?
e?.stack
:
undefined

});

}

};

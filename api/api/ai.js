export default async function handler(req,res){

if(req.method!=="POST"){
return res.status(405).json({
ok:false,
error:"Method not allowed"
});
}

try{

const apiKey=process.env.OPENAI_API_KEY;

if(!apiKey){
return res.status(500).json({
ok:false,
error:"尚未設定 OPENAI_API_KEY"
});
}

const {
question,
context
}=req.body||{};

if(!question){
return res.status(400).json({
ok:false,
error:"請輸入問題"
});
}

const systemPrompt=`
你是「幽冥分析」內建的股票技術分析助手。

你的工作是根據網站傳入的即時股票資料回答使用者。

回答使用繁體中文。

重要規則：

1. 優先使用傳入的實際數據，不要自行捏造價格。
2. 清楚區分：
   - 目前價格
   - 使用者成本
   - 減資後調整成本
   - 技術支撐
   - 策略進場區
   - SL1
   - SL2
   - TP1 / TP2 / TP3
3. 如果使用者有輸入減資，分析必須使用減資後持股數與調整後成本。
4. 可以計算：
   - 距離成本百分比
   - 回本需要漲幅
   - 加碼後平均成本
   - 距離停損百分比
   - 風險報酬
5. 不要把策略分數描述成上漲機率。
6. 365 天歷史勝率只代表歷史回測，不代表未來勝率。
7. 不保證獲利。
8. 使用者問「現在能不能買／加碼」時，不要只回答可以或不可以。
   請直接說明目前價格位於哪個技術區域、哪些條件成立、哪些風險點尚未解除。
9. 回答盡量直接，不要過度冗長。
10. 若資料不足，要明確說缺少哪一項資料。

你可以用以下結構回答：

目前狀況
關鍵價位
持倉影響
需要注意的風險

不需要每次都固定使用完全相同格式。
`;

const userPrompt=`
使用者問題：

${question}

目前幽冥分析資料：

${JSON.stringify(context,null,2)}
`;

const response=await fetch(
"https://api.openai.com/v1/responses",
{
method:"POST",
headers:{
"Authorization":`Bearer ${apiKey}`,
"Content-Type":"application/json"
},
body:JSON.stringify({
model:"gpt-5.6-luna",
input:[
{
role:"system",
content:[
{
type:"input_text",
text:systemPrompt
}
]
},
{
role:"user",
content:[
{
type:"input_text",
text:userPrompt
}
]
}
],
max_output_tokens:1200
})
}
);

const data=await response.json();

if(!response.ok){
console.error(data);

return res.status(response.status).json({
ok:false,
error:
data?.error?.message||
"OpenAI API 連線失敗"
});
}

let answer="";

if(typeof data.output_text==="string"){
answer=data.output_text;
}

if(!answer&&Array.isArray(data.output)){

for(const item of data.output){

if(!Array.isArray(item.content))continue;

for(const content of item.content){

if(
content.type==="output_text"&&
typeof content.text==="string"
){
answer+=content.text;
}

}

}

}

if(!answer){
answer="目前沒有取得 AI 回答。";
}

return res.status(200).json({
ok:true,
answer
});

}catch(error){

console.error(error);

return res.status(500).json({
ok:false,
error:
error?.message||
"AI 分析發生錯誤"
});

}

}

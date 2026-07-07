const https=require('https');const {loadEnv,CC_BILLING_HEADER}=require('./lib');loadEnv();
const t=process.env.SETUP_TOKEN||process.env.ANTHROPIC_SETUP_TOKEN;
const body=JSON.stringify({model:'claude-sonnet-5',max_tokens:2048,stream:true,
  system:[{type:'text',text:CC_BILLING_HEADER},{type:'text',text:'Use tools when appropriate.'}],
  tools:[{name:'get_weather',description:'Weather',input_schema:{type:'object',properties:{city:{type:'string'}},required:['city']}}],
  messages:[{role:'user',content:'Weather in Tbilisi? Use get_weather then tell me.'}]});
const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14','Authorization':`Bearer ${t}`}},res=>{let buf='';res.on('data',c=>buf+=c);res.on('end',()=>{
  for(const line of buf.split('\n')){if(!line.startsWith('data:'))continue;const j=line.slice(5).trim();if(j==='[DONE]')continue;let p;try{p=JSON.parse(j)}catch{continue}
    if(p.type==='content_block_start'&&p.content_block&&(p.content_block.type==='thinking'||p.content_block.type==='redacted_thinking'))console.log('START idx',p.index,JSON.stringify(p.content_block));
    if(p.type==='content_block_delta'&&/thinking|signature/.test(p.delta?.type||''))console.log('DELTA idx',p.index,p.delta.type,JSON.stringify(p.delta).slice(0,80));
  }});});
req.end(body);

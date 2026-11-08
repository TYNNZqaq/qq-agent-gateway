export class CodexRunner {async run(){return {status:'needs_input',summary:'旧执行通道的记录已保留。请在授权项目中新建插件任务。',error:'LEGACY_BACKEND_REQUIRES_REVIEW'};}}
export class MockRunner {async run(task,{signal}={}){return signal?.aborted?{status:'cancelled',summary:'模拟任务已取消。'}:{status:'succeeded',summary:'本地模拟完成：'+task.prompt,threadId:'mock-'+task.id};}}

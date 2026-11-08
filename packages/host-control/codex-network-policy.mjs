// Only an already-configured, credential-free local HTTP proxy may cross into
// the parent Codex API client. Model command environments remain inherit=none.
export function localCodexProxy(environment={}){
  const value=Object.entries(environment).find(([k])=>k.toUpperCase()==='HTTPS_PROXY')?.[1]||Object.entries(environment).find(([k])=>k.toUpperCase()==='HTTP_PROXY')?.[1]||Object.entries(environment).find(([k])=>k.toUpperCase()==='ALL_PROXY')?.[1];
  if(typeof value!=='string'||value.length>512)return {};
  let url;try{url=new URL(value);}catch{return {};}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||!url.port||Number(url.port)<1||url.pathname!=='/'||url.search||url.hash)return {};
  return {HTTPS_PROXY:url.origin,HTTP_PROXY:url.origin,NO_PROXY:'localhost,127.0.0.1,::1'};
}

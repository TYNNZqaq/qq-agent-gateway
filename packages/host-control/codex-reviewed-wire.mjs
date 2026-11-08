// The exact alpha.6 --experimental schema retains the named profile fields.
// Match them to startup configuration and the profile acknowledged for this
// exact thread. Preserve the fields; stable-only schemas omit them by design.
export function reviewedCodexRequest(version,method,params,{defaultProfile,threadProfile}={}){
 if(version!=='0.166.0-alpha.6')return params;
 const key=method==='command/exec'?'permissionProfile':['thread/start','thread/resume','turn/start'].includes(method)?'permissions':null;
 if(!key||!Object.hasOwn(params,key))return params;
 const profile=params[key];
 if(typeof profile!=='string'||!/^qq-project(?:-[a-f0-9-]{36})?$/.test(profile)||profile!==defaultProfile)throw Error('CLI_PERMISSION_PROFILE_MISMATCH');
 if(method==='turn/start'&&threadProfile!==profile)throw Error('CLI_PERMISSION_PROFILE_MISMATCH');
 if(method.startsWith('thread/')&&params.config?.default_permissions!==profile)throw Error('CLI_PERMISSION_PROFILE_MISMATCH');
 return params;
}

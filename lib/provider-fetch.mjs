import {fetch as proxyFetch,EnvHttpProxyAgent} from 'undici';
export function createProviderTransport(){
 const hasProxy=Boolean(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy);
 const dispatcher=hasProxy?new EnvHttpProxyAgent():null;
 return {fetchImpl:dispatcher?(url,options)=>proxyFetch(url,{...options,dispatcher}):(url,options)=>fetch(url,options),close(){if(dispatcher)void dispatcher.close().catch(()=>{});}};
}

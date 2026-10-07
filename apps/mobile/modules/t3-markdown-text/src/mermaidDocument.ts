/** Keep authored diagram text out of HTML and executable script syntax. */
export function mermaidDocument(script: string, code: string, theme: "light" | "dark") {
  const configuration = JSON.stringify({ code, theme }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>body{margin:0;padding:12px;color:${theme === "dark" ? "#eee" : "#222"};font-family:system-ui}svg{display:block;max-width:100%;height:auto;margin:auto}</style>
</head><body><div id="diagram"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script>
<script>
const config=${configuration};
mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,theme:config.theme==='dark'?'dark':'default'});
const post=(value)=>window.ReactNativeWebView.postMessage(JSON.stringify(value));
mermaid.render('t3-mermaid',config.code).then(({svg})=>{
document.getElementById('diagram').innerHTML=svg;
post({height:Math.ceil(document.body.getBoundingClientRect().height)});
}).catch(()=>post({error:true}));
</script></body></html>`;
}

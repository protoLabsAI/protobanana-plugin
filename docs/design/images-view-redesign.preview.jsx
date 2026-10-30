import { Icon, Empty, Spinner } from '@pl/ui';

const css = `
.pv-ctl{display:flex;flex-wrap:wrap;gap:var(--pl-space-3);align-items:center;margin-bottom:var(--pl-space-3);font-size:12px;color:var(--pl-color-fg-muted)}
.pv-frame{border:1px solid var(--pl-color-border-strong);border-radius:var(--pl-radius);overflow:hidden;margin:0 auto;transition:width .2s}
.st{container-type:inline-size;display:grid;grid-template-rows:auto 1fr;height:640px;font-family:var(--pl-font-sans)}
.st-head{display:flex;align-items:center;gap:var(--pl-space-3);padding:var(--pl-space-2) var(--pl-space-3);border-bottom:1px solid var(--pl-color-border)}
.st-title{display:flex;flex-direction:column;line-height:1.2}
.st-title b{font-size:14px}.st-title span{font-size:11px;color:var(--pl-color-fg-subtle);font-family:var(--pl-font-mono)}
.st-sp{flex:1}
.st-body{display:grid;grid-template-columns:1fr 248px;min-height:0}
.st-main{display:grid;grid-template-rows:1fr auto auto auto;min-height:0;min-width:0}
.st-canvas{position:relative;background:var(--pl-color-bg-inset);display:grid;place-items:center;min-height:0;overflow:hidden}
.st-img{aspect-ratio:1/1;height:min(86%,380px);border:1px solid var(--pl-color-border);border-radius:var(--pl-radius);background:var(--pl-color-bg-subtle);display:grid;place-items:center;color:var(--pl-color-fg-subtle);position:relative;overflow:hidden}
.st-img.dim{opacity:.45}
.st-split{position:absolute;inset:0 50% 0 0;background:var(--pl-color-bg-hover);border-right:2px solid var(--pl-color-accent);display:grid;place-items:center;font-size:11px}
.st-knob{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;background:var(--pl-color-accent);color:var(--pl-color-fg-on-accent);display:grid;place-items:center}
.st-mask{position:absolute;left:30%;top:35%;width:34%;height:28%;border-radius:40%;background:var(--pl-color-accent);opacity:.35}
.st-tool{position:absolute;top:var(--pl-space-2);right:var(--pl-space-2);display:flex;gap:var(--pl-space-1);background:var(--pl-color-bg-raised);border:1px solid var(--pl-color-border);border-radius:var(--pl-radius);padding:var(--pl-space-1)}
.st-tool.left{right:auto;left:var(--pl-space-2)}
.st-over{position:absolute;inset:auto var(--pl-space-3) var(--pl-space-3);display:flex;justify-content:center}
.st-status{display:flex;gap:var(--pl-space-2);align-items:center;background:var(--pl-color-bg-raised);border:1px solid var(--pl-color-border);border-radius:var(--pl-radius);padding:var(--pl-space-2) var(--pl-space-3);font-size:12px}
.st-bar{height:3px;width:120px;background:var(--pl-color-bg-subtle);border-radius:2px;overflow:hidden}
.st-bar i{display:block;height:100%;width:45%;background:var(--pl-color-accent)}
.st-actions{display:flex;gap:var(--pl-space-1);align-items:center;padding:var(--pl-space-2) var(--pl-space-3);border-top:1px solid var(--pl-color-border);flex-wrap:nowrap;overflow:hidden}
.st-strip{display:flex;gap:var(--pl-space-1_5);align-items:center;padding:var(--pl-space-2) var(--pl-space-3);border-top:1px solid var(--pl-color-border);overflow:hidden}
.st-th{width:44px;height:44px;flex:none;border-radius:var(--pl-radius);background:var(--pl-color-bg-subtle);border:1px solid var(--pl-color-border);display:grid;place-items:center;color:var(--pl-color-fg-subtle);font-size:10px;position:relative}
.st-th.on{outline:2px solid var(--pl-color-focus);outline-offset:1px}
.st-fork{font-size:10px;color:var(--pl-color-fg-subtle);font-family:var(--pl-font-mono)}
.st-comp{display:grid;grid-template-columns:1fr auto;gap:var(--pl-space-2);padding:var(--pl-space-3);border-top:1px solid var(--pl-color-border);position:relative}
.st-comp textarea{min-height:52px;resize:none}
.st-cbtns{display:flex;flex-direction:column;gap:var(--pl-space-1_5);justify-content:flex-end}
.st-mode{display:flex;gap:var(--pl-space-2);align-items:center;grid-column:1/-1;font-size:12px;color:var(--pl-color-fg-muted)}
.st-pop{position:absolute;right:var(--pl-space-3);bottom:calc(100% - var(--pl-space-2));width:280px;z-index:2;display:grid;gap:var(--pl-space-3);background:var(--pl-color-bg-raised);border:1px solid var(--pl-color-border-strong);border-radius:var(--pl-radius);padding:var(--pl-space-3);box-shadow:var(--pl-shadow-popover);font-size:12px}
.st-pop label{display:block;color:var(--pl-color-fg-muted);margin-bottom:var(--pl-space-1)}
.st-hist{border-left:1px solid var(--pl-color-border);display:grid;grid-template-rows:auto 1fr;min-height:0}
.st-hh{display:flex;align-items:center;gap:var(--pl-space-2);padding:var(--pl-space-2) var(--pl-space-3);border-bottom:1px solid var(--pl-color-border);font-size:12px}
.st-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--pl-space-1_5);padding:var(--pl-space-3);overflow:auto;align-content:start}
.st-gt{aspect-ratio:1;border-radius:var(--pl-radius);background:var(--pl-color-bg-subtle);border:1px solid var(--pl-color-border);position:relative}
.st-gt em{position:absolute;left:3px;bottom:3px;font-style:normal;font-size:9px;font-family:var(--pl-font-mono);color:var(--pl-color-fg-muted);background:var(--pl-color-bg-raised);padding:0 3px;border-radius:2px}
.st-narrow-only{display:none}
@container (max-width: 780px){
  .st-body{grid-template-columns:1fr}.st-hist{display:none}.st-narrow-only{display:inline-flex}
  .st-wide-only{display:none}
}
.note{font-size:11px;color:var(--pl-color-fg-subtle);margin-top:var(--pl-space-2);text-align:center}
`;

const STATES = [['empty','Empty'],['rendering','Rendering'],['result','Result'],['compare','Compare'],['inpaint','Inpaint'],['timeout','GPU busy (524)']];
const OPS = [['vary','Vary','shuffle'],['edit','Edit','pencil'],['region','Region','scan'],['inpaint','Inpaint','brush'],['outpaint','Outpaint','expand'],['bg','Remove BG','eraser'],['compose','Compose','layers']];

function B({icon,children,primary,ghost,label,on,...r}){
  const cls=['pl-btn','pl-btn--sm',primary&&'pl-btn--primary',ghost&&'pl-btn--ghost',!children&&'pl-btn--icon'].filter(Boolean).join(' ');
  return <button type="button" className={cls} aria-label={label} title={label} aria-pressed={on} {...r}>{icon&&<Icon name={icon} size={14}/>}{children}</button>;
}

function App(){
  const [s,setS]=React.useState('result');
  const [narrow,setNarrow]=React.useState(false);
  const [opts,setOpts]=React.useState(false);
  const hasImg=!['empty'].includes(s);
  const mode=s==='inpaint'?'Inpaint':null;
  return <div>
    <style>{css}</style>
    <div className="pv-ctl">
      <span>Preview state</span>
      <div className="pl-segmented" role="group" aria-label="Preview state">
        {STATES.map(([id,l])=><button key={id} type="button" className={'pl-seg'+(s===id?' pl-seg--active':'')} aria-pressed={s===id} onClick={()=>setS(id)}>{l}</button>)}
      </div>
      <label style={{display:'flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={narrow} onChange={e=>setNarrow(e.target.checked)}/> Work panel open (narrow)</label>
    </div>

    <div className="pv-frame" style={{width:narrow?'620px':'100%'}}>
      <div className="st">
        <header className="st-head">
          <div className="st-title"><span>protoBanana</span><b>Images</b></div>
          <div className="pl-tabs pl-tabs--segmented" role="tablist" aria-label="Mode">
            <button className="pl-tab pl-tab--active" role="tab" aria-selected="true">Playground</button>
            <button className="pl-tab" role="tab" aria-selected="false" disabled title="Slice 2 — xyflow pipeline canvas">Pipelines</button>
          </div>
          <div className="st-sp"/>
          {(s==='rendering')&&<span className="pl-badge" title="1 render in flight"><Spinner/> 1 rendering</span>}
          <B icon="plus" ghost>New</B>
          <span className="st-narrow-only"><B icon="history" ghost>History</B></span>
        </header>

        <div className="st-body">
          <div className="st-main">
            <div className="st-canvas" aria-label="Canvas">
              {s==='empty' && <Empty icon={<Icon name="image"/>} title="Describe an image to start" desc="Or bring one in to edit: drop a file, paste, or pick from History." action={<B icon="upload">Upload image</B>}/>}
              {hasImg && <div className={'st-img'+(s==='rendering'?' dim':'')}>
                <Icon name="image" size={40}/>
                {s==='compare'&&<><div className="st-split">parent</div><div className="st-knob" role="slider" aria-label="Compare split" aria-valuenow={50} tabIndex={0}><Icon name="move-horizontal" size={12}/></div></>}
                {s==='inpaint'&&<div className="st-mask"/>}
              </div>}
              {hasImg && s!=='inpaint' && <div className="st-tool" aria-label="View tools">
                <B icon="minus" ghost label="Zoom out"/><span style={{fontSize:11,alignSelf:'center',padding:'0 4px'}}>Fit</span><B icon="plus" ghost label="Zoom in"/>
                <B icon="columns-2" ghost on={s==='compare'} label="Compare with parent"/>
                <B icon="maximize" ghost label="Fullscreen"/>
              </div>}
              {s==='inpaint' && <div className="st-tool left" aria-label="Mask tools">
                <B icon="brush" on label="Brush"/><B icon="eraser" ghost label="Eraser"/>
                <span style={{fontSize:11,alignSelf:'center',padding:'0 6px',color:'var(--pl-color-fg-muted)'}}>Size ▬▬●▬ 40</span>
                <B icon="flip-horizontal" ghost label="Invert mask"/><B icon="undo-2" ghost label="Undo"/><B icon="trash-2" ghost label="Clear mask"/>
              </div>}
              {s==='rendering' && <div className="st-over"><div className="st-status" role="status">
                <Spinner/><span><b>Rendering edit</b> · 14s · usually ~25s</span><div className="st-bar"><i/></div>
                <B ghost label="Stop tracking (the GPU finishes the job)">Stop</B></div></div>}
              {s==='timeout' && <div className="st-over"><div className="pl-callout pl-callout--warning" role="status" style={{maxWidth:440,background:'var(--pl-color-bg-raised)'}}>
                <b>GPU busy</b> — the gateway timed out (524) after 100s. Your render may still land in History.
                <div style={{display:'flex',gap:8,marginTop:8}}><B primary icon="rotate-ccw">Retry</B><B ghost>Edit prompt</B></div></div></div>}
            </div>

            {hasImg && !mode && <div className="st-actions" aria-label="Image actions">
              {OPS.map(([id,l,ic],i)=><span key={id} className={i>3?'st-wide-only':''}><B icon={ic} ghost>{l}</B></span>)}
              <span className="st-narrow-only"><B icon="ellipsis" ghost label="More edits">More</B></span>
              <div className="st-sp"/>
              <B icon="star" ghost label="Star (keep)"/><B icon="download" ghost label="Download"/>
              <B icon="send">Send to agent</B>
            </div>}

            {hasImg && <div className="st-strip" aria-label="This image's history">
              <div className="st-th">gen</div><span className="st-fork">→</span>
              <div className="st-th">edit</div><span className="st-fork">→</span>
              <div className={'st-th'+(s!=='rendering'?' on':'')}>region</div>
              {s==='rendering'&&<><span className="st-fork">→</span><div className="st-th on"><Spinner/></div></>}
              <span className="st-fork" style={{marginLeft:8}}>⑂ 2 variants</span>
            </div>}

            <div className="st-comp">
              {mode && <div className="st-mode"><span className="pl-chip"><span className="pl-chip-label">Inpaint · paint the area to change</span></span><B ghost icon="x" label="Exit inpaint"/></div>}
              <textarea className="pl-textarea" aria-label={mode?'What should go in the painted area?':hasImg?'Describe the change':'Prompt'}
                placeholder={mode?'What should go in the painted area?':hasImg?'Describe a change to this image…':'A ceramic banana on a marble plinth, soft studio light'}/>
              <div className="st-cbtns">
                <B icon="sliders-horizontal" on={opts} onClick={()=>setOpts(!opts)}>1:1 · Final</B>
                <B primary>{mode?'Inpaint':hasImg?'Apply edit':'Generate'}</B>
              </div>
              {opts && <div className="st-pop" role="dialog" aria-label="Options">
                <div><label>Aspect</label><div className="pl-segmented">{['1:1','3:4','4:3','16:9','9:16'].map((a,i)=><button key={a} className={'pl-seg'+(i===0?' pl-seg--active':'')}>{a}</button>)}</div></div>
                <div><label>Quality</label><div className="pl-segmented"><button className="pl-seg">Draft · fast</button><button className="pl-seg pl-seg--active">Final</button></div></div>
                <div><label htmlFor="neg">Avoid (negative prompt)</label><input id="neg" className="pl-input" placeholder="text, watermark"/></div>
                <div><label htmlFor="seed">Seed</label><div style={{display:'flex',gap:6}}><input id="seed" className="pl-input" placeholder="Random each run"/><B icon="lock" ghost label="Lock seed"/></div></div>
              </div>}
            </div>
          </div>

          <aside className="st-hist" aria-label="History">
            <div className="st-hh"><b>History</b><div className="st-sp"/><B icon="list-filter" ghost label="Filter: op, source, starred"/></div>
            <div className="st-grid">
              {['studio','agent','studio','studio','agent','studio','studio','agent','studio','studio','studio','agent'].map((src,i)=><div key={i} className="st-gt">{src==='agent'&&<em>agent</em>}</div>)}
            </div>
          </aside>
        </div>
      </div>
    </div>
    <p className="note">Grey squares stand in for images. Toggle "Work panel open": History moves behind a header button, and the less-used edit ops collapse into a More menu.</p>
  </div>;
}
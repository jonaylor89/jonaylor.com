import json, sys, re
t = json.load(open(sys.argv[1]))
toks = {x['name']: x['value'] for x in t['color']['tokens']}
themes = ['light', 'dark', 'sunlight', 'night']
def val(name, th):
    v = toks[name]
    if isinstance(v, str):
        m = re.fullmatch(r'\{(.+)\}', v)
        return val(m.group(1), th) if m else v
    return v.get(th, v['light'])
def hexc(name, th):
    h = val(name, th).lstrip('#')
    return f"Color(0xFF{h.upper()})"
def camel(n): 
    p = n.split('-'); return p[0] + ''.join(x.capitalize() for x in p[1:])
m3 = ['primary','on-primary','primary-container','on-primary-container','inverse-primary',
 'secondary','on-secondary','secondary-container','on-secondary-container',
 'tertiary','on-tertiary','tertiary-container','on-tertiary-container',
 'surface','on-surface','on-surface-variant','surface-dim','surface-bright',
 'surface-container-lowest','surface-container-low','surface-container','surface-container-high','surface-container-highest',
 'inverse-surface','inverse-on-surface','error','on-error','error-container','on-error-container','outline','outline-variant','scrim']
out = ["// GENERATED from the Parlo design system tokens.json (scripts/generate-theme-colors.py). Do not edit by hand.",
"package com.parlo.app.ui.theme", "", "import androidx.compose.material3.darkColorScheme", "import androidx.compose.material3.lightColorScheme", "import androidx.compose.ui.graphics.Color", ""]
for th in themes:
    fn = 'lightColorScheme' if th in ('light','sunlight') else 'darkColorScheme'
    out.append(f"internal val {th.capitalize()}Scheme = {fn}(")
    for n in m3:
        out.append(f"    {camel(n)} = {hexc(n, th)},")
    out.append(f"    background = {hexc('surface', th)},")
    out.append(f"    onBackground = {hexc('on-surface', th)},")
    out.append(f"    surfaceVariant = {hexc('surface-container-highest', th)},")
    out.append(f"    surfaceTint = {hexc('primary', th)},")
    out.append(")\n")
tongues = ['coral','amber','lime','teal','sky','indigo','plum','rose']
for th in themes:
    out.append(f"internal val {th.capitalize()}Fixed = ParloFixedColors(")
    out.append("    tongues = listOf(")
    for tg in tongues:
        out.append(f"        TongueTone(\"{tg}\", {hexc('tongue-'+tg, th)}, {hexc('tongue-'+tg+'-container', th)}, {hexc('on-tongue-'+tg+'-container', th)}),")
    out.append("    ),")
    out.append("    reviewStages = listOf(" + ", ".join(hexc(f'review-stage-{i}', th) for i in range(1,7)) + "),")
    for n in ['primary-fixed','on-primary-fixed','tertiary-fixed','on-tertiary-fixed','dev-badge','on-dev-badge']:
        out.append(f"    {camel(n)} = {hexc(n, th)},")
    out.append(")\n")
print("\n".join(out))

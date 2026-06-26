import re, subprocess

# ============================================================
# 0) Pull the deleted theme blocks from git commit 5648bd6
# ============================================================
old_css = subprocess.run(['git', 'show', '5648bd6:public/style.css'], capture_output=True, text=True, cwd='.').stdout
old_i18n = subprocess.run(['git', 'show', '5648bd6:public/i18n.js'], capture_output=True, text=True, cwd='.').stdout
old_app = subprocess.run(['git', 'show', '5648bd6:public/app.js'], capture_output=True, text=True, cwd='.').stdout

# Extract each deleted theme CSS block (one regex per theme)
def extract_block(theme_name, src):
    pat = re.compile(rf'(/\*[^\n]*?\b{theme_name}\b[^\n]*?\*/\s*\n)?body\[data-theme="{theme_name}"\][^{{]*?{{.*?^\}}\s*\n', re.MULTILINE | re.DOTALL)
    m = pat.search(src)
    if m: return m.group(0).rstrip('\n') + '\n\n'
    # Fallback: bare block
    pat2 = re.compile(rf'body\[data-theme="{theme_name}"\][^{{]*?{{.*?^\}}\s*\n', re.MULTILINE | re.DOTALL)
    m2 = pat2.search(src)
    if m2: return m2.group(0).rstrip('\n') + '\n\n'
    return ''

theme_order = ['amber', 'red', 'vice', 'nord', 'lofi', 'aero']
css_blocks = {t: extract_block(t, old_css) for t in theme_order}
for t in theme_order:
    print(f'  {t}: extracted {len(css_blocks[t])} chars')

# ============================================================
# 1) style.css — append the deleted theme blocks BEFORE the
#    disable-animations footer / mono-block boundary.
# ============================================================
p1 = 'public/style.css'
with open(p1, 'r', encoding='utf-8') as f:
    css = f.read()

anchor = '@media (max-width: 720px)'
if anchor in css:
    insertion = ''.join(css_blocks[t] for t in theme_order)
    css = css.replace(anchor, insertion + anchor, 1)
    with open(p1, 'w', encoding='utf-8') as f:
        f.write(css)
    print(f'  inserted {len(insertion)} chars before @media in style.css')

# ============================================================
# 2) app.js — THEMES array and the call-ring handler fix
# ============================================================
p2 = 'public/app.js'
with open(p2, 'r', encoding='utf-8') as f:
    app = f.read()

# 2a) THEMES array
old_theme_lines = []
for line in old_app.split('\n'):
    m = re.search(r'\{\s*key:\s*"(?:amber|red|vice|nord|lofi|aero)"', line)
    if m: old_theme_lines.append(line)
print(f'  found {len(old_theme_lines)} old theme entries in commit 5648bd6')

old_themes_recovery = '\n'.join('  ' + ln.strip().rstrip(',') + ',' for ln in old_theme_lines) + '\n'
mono_end_re = re.compile(r'(\{\s*key:\s*"mono"[^}]+\}),\s*\n(\s*\];)', re.MULTILINE)
m = mono_end_re.search(app)
if m:
    app = app[:m.end(1)] + '\n' + old_themes_recovery + m.group(2) + app[m.end(2):]
    with open(p2, 'w', encoding='utf-8') as f:
        f.write(app)
    print('  appended 6 theme entries to THEMES array')

# 2b) Fix call-ring handler
m = re.search(r'socket\.on\("call-ring",\s*\(([^)]*)\)\s*=>\s*\{', app)
if m:
    open_brace = m.end() - 1
    depth = 0; i = open_brace; found = False
    while i < len(app):
        c = app[i]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: found = True; break
        i += 1
    if found:
        params = m.group(1)
        new_body = (
            '\n  if (call.active) return;\n'
            '  ensureAudioCtx();\n'
            '  if (!isMuted(p.room) && !isDnd()) {\n'
            '    sfx.call();\n'
            '    notify(t("call_in", { title: p.title }));\n'
            '    if (_customRingtone) setTimeout(playCustomRingtone, 110);\n'
            '  }\n'
            '  const kind = p.room.startsWith("@grp:") ? "group" : "dm";\n'
            '  showToast(p.from, p.name, { room: p.room, title: p.title, kind });\n'
        )
        replacement = f'socket.on("call-ring", ({params}) => {{{new_body}}});'
        new_app = app[:m.start()] + replacement + app[i+1:]
        with open(p2, 'w', encoding='utf-8') as f:
            f.write(new_app)
        print('  rewrote call-ring handler to play sfx.call + custom ringtone')

# ============================================================
# 3) i18n.js — add EN + RU keys
# ============================================================
p3 = 'public/i18n.js'
with open(p3, 'r', encoding='utf-8') as f:
    i18n = f.read()

en_additions = {}
ru_additions = {}
for lang, target in (('en', en_additions), ('ru', ru_additions)):
    bm = re.search(rf'\b{lang}:\s*\{{(.*?)\n  \}},', old_i18n, re.DOTALL)
    if not bm: continue
    body = bm.group(1)
    for k in theme_order:
        for jkey in (f'theme_{k}', f'theme_desc_{k}'):
            mk = re.search(rf'\s*{jkey}:\s*"([^"]*)"\s*,?\s*\n', body)
            if mk:
                v = mk.group(1)
                has_comma = mk.group(0).rstrip().endswith(',')
                target[jkey] = (v, has_comma)

for lang, target in (('en', en_additions), ('ru', ru_additions)):
    bm = re.search(rf'(\b{lang}:\s*\{{)(.*?)(\n  \}},)', i18n, re.DOTALL)
    if not bm: continue
    prefix, body, suffix = bm.group(1), bm.group(2), bm.group(3)
    last_idx = -1
    for m in re.finditer(r'^\s*theme_(?:desc_)?(?:contrast|midnight|dracula|flashbang|mono)[^:\n]*:\s*"[^"]*"(,?)\s*\n', body, re.MULTILINE):
        last_idx = m.end()
    if last_idx == -1: last_idx = len(body)
    ins_lines = []
    for jkey, (val, has_comma) in target.items():
        ins_lines.append(f'    {jkey}: "{val}"' + (',' if not has_comma else ',') + '\n')
    insertion = ''.join(ins_lines)
    new_body = body[:last_idx] + insertion + body[last_idx:]
    i18n = i18n[:bm.start()] + prefix + new_body + suffix + i18n[bm.end():]
    with open(p3, 'w', encoding='utf-8') as f:
        f.write(i18n)
    print(f'  added {len(target)} i18n keys to {lang} block')

print('===')
for f in ('public/app.js', 'public/i18n.js'):
    r = subprocess.run(['node', '-c', f], capture_output=True, text=True)
    print(f'  {f}: {"OK" if r.returncode==0 else "FAIL "+r.stderr.strip()}')

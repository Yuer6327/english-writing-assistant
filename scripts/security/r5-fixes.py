import io, re

# ── 1) billing index.ts: 11 处 body=null 收口（与 writing 4ccfea4 同款） ──
p = '../Yuer6327-billing/src/index.ts'
s = io.open(p, encoding='utf-8').read()
pat = re.compile(r"await c\.req\.json(<[^>]*>)?\(\)\.catch\(\(\) => \(\{\}\) as (\w+)\)")
def repl(m):
    return f"((await c.req.json{m.group(1) or ''}().catch(() => null)) ?? ({{}} as {m.group(2)}))"
s2, n = pat.subn(repl, s)
assert n >= 10, f'unexpected count {n}'
io.open(p, 'w', encoding='utf-8', newline='\n').write(s2)
print(f'billing index.ts: {n} 处 body=null 收口')

# ── 2) writing prompts.ts: getEffectivePrompt 的 DEFAULT_PROMPTS 读法防原型键（存量数据兼容） ──
p = 'src/utils/prompts.ts'
s = io.open(p, encoding='utf-8').read()
old = "const def = DEFAULT_PROMPTS[genre] ?? '';"
assert old in s
s = s.replace(old, "// hasOwn：存量库若存有 '__proto__' genre（修复前写入），?? 防不住 Object.prototype 真值\n"
                  "  const def = Object.hasOwn(DEFAULT_PROMPTS, genre) ? DEFAULT_PROMPTS[genre] : '';")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('prompts getEffectivePrompt hasOwn done')

# getEffectivePrompt 里另一处 DEFAULT_PROMPTS 读法（若有）
s = io.open(p, encoding='utf-8').read()
import re as _re
hits = [(m.start(), m.group(0)) for m in _re.finditer(r"DEFAULT_PROMPTS\[", s)]
print('remaining DEFAULT_PROMPTS[ reads:', len(hits))

# ── 3) swup.js: 模块加载窗口期的 stale-init 复核 ──
p = 'public/js/swup.js'
s = io.open(p, encoding='utf-8').read()
old = "    const mod = await loadPageModule(path);"
if old in s:
    s = s.replace(old,
      "    const mod = await loadPageModule(path);\n"
      "    // 模块 fetch 期间用户可能已切走：旧页 init 跑在新页 DOM 上会造成跳页/错渲染，复核后放弃\n"
      "    if (path !== currentPath) return;")
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print('swup currentPath recheck done')
else:
    print('swup pattern not found — inspect manually')

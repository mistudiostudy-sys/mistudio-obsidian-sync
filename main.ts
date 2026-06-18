/*
  MiStudio Sync — plugin de Obsidian (Obsidian como cliente).

  Trae tus carpetas y apuntes de MiStudio al vault como .md y, si activas el modo
  two-way, también devuelve a MiStudio lo que edites en Obsidian.

  Auth: una API key de larga duración (mist_…) que generas en
  {baseUrl}/obsidian. (También admite pegar un access token de Supabase, que
  caduca ~1h, por compatibilidad.)

  Reconciliación two-way (por entrada, identificada por `mistudio_id`):
    - solo remoto cambió  → se baja al vault (pull).
    - solo local cambió   → se sube a MiStudio (push).
    - ambos cambiaron     → gana remoto, y tu versión local se guarda como
                            `<nombre>.conflict-<fecha>.md` (nada se pierde).
  Un "journal" (hash por entrada) recuerda el último estado sincronizado.

  Las carpetas filofax (dos páginas) son por ahora SOLO de bajada.
*/
import {
  App, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl,
} from 'obsidian'

interface MiStudioSettings {
  baseUrl: string
  apiKey: string
  accessToken: string
  targetFolder: string
  autoSyncMinutes: number
  twoWay: boolean
  syncTasks: boolean        // traer tareas (To-Do) y calendario como .md
  dailyNote: boolean        // crear/actualizar la nota diaria con lo de hoy
  syncFolders: string[]     // ids de carpetas a sincronizar; [] = todas
  journal: Record<string, string>    // mistudio_id → hash del último md sincronizado
  taskJournal: Record<string, boolean>  // task id → último estado `done` sincronizado
}

const DEFAULTS: MiStudioSettings = {
  baseUrl: 'https://mistudiostudy.vercel.app',
  apiKey: '',
  accessToken: '',
  targetFolder: 'MiStudio',
  autoSyncMinutes: 0,
  twoWay: false,
  syncTasks: false,
  dailyNote: false,
  syncFolders: [],
  journal: {},
  taskJournal: {},
}

interface ExportEntry { id: string; title: string; createdAt: string | null; contentHtml: string; contentRightHtml: string }
interface ExportFolder { id: string; name: string; color: string; lined: boolean; layout: 'single' | 'filofax'; entries: ExportEntry[] }
interface ExportTask { id: string | null; text: string; done: boolean; date: string | null }
interface ExportEvent { date: string; text: string }
interface ExportPlanItem { topic: string; course: string | null; method: string; minutes: number; slot: string; reason: string; done: boolean }
interface ExportResponse { ok: boolean; updatedAt?: string | null; folders: ExportFolder[]; tasks?: ExportTask[]; events?: ExportEvent[]; plan?: ExportPlanItem[]; brief?: string | null; error?: string }

// ── Nota diaria / tareas / calendario (Life Planner ↔ Obsidian) ─────────────
const ORG_START = '<!-- mistudio:start -->'
const ORG_END = '<!-- mistudio:end -->'

function todayLocalISO(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

// Tareas como checkboxes compatibles con el plugin "Tasks" (fecha → 📅 YYYY-MM-DD).
// El marcador HTML invisible <!--ms:ID--> permite devolver el check a MiStudio.
function tasksMarkdown(tasks: ExportTask[]): string {
  const line = (t: ExportTask) => `- [${t.done ? 'x' : ' '}] ${t.text}${t.date ? ` 📅 ${t.date}` : ''}${t.id ? ` <!--ms:${t.id}-->` : ''}`
  const pending = tasks.filter(t => !t.done)
  const done = tasks.filter(t => t.done)
  const out = ['---', 'source: mistudio', 'type: tareas', `synced: ${new Date().toISOString()}`, '---', '',
    '# Tareas · MiStudio', '', '> Vista generada por MiStudio Sync — se reescribe en cada sincronización.', '']
  if (pending.length) out.push('## Pendientes', ...pending.map(line), '')
  if (done.length) out.push('## Hechas', ...done.map(line), '')
  if (!tasks.length) out.push('_No hay tareas en tu Workspace._')
  return out.join('\n') + '\n'
}

// Lee el estado `done` por id desde un Tareas.md existente (para el two-way).
function parseTaskChecks(content: string): Map<string, boolean> {
  const map = new Map<string, boolean>()
  const re = /^- \[([ xX])\].*?<!--ms:([A-Za-z0-9_-]+)-->/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) map.set(m[2], m[1].toLowerCase() === 'x')
  return map
}

function calendarMarkdown(events: ExportEvent[]): string {
  const byDate = new Map<string, string[]>()
  for (const e of events) {
    const list = byDate.get(e.date) ?? []
    list.push(e.text); byDate.set(e.date, list)
  }
  const out = ['---', 'source: mistudio', 'type: calendario', `synced: ${new Date().toISOString()}`, '---', '',
    '# Calendario · MiStudio', '', '> Vista generada por MiStudio Sync — se reescribe en cada sincronización.', '']
  for (const date of Array.from(byDate.keys()).sort()) {
    out.push(`## ${date}`, ...byDate.get(date)!.map(t => `- ${t}`), '')
  }
  if (!events.length) out.push('_No hay eventos en tu calendario._')
  return out.join('\n') + '\n'
}

// Plan diario de Phil: etiquetas legibles por franja y método de estudio.
const SLOT_LABEL: Record<string, string> = { manana: '🌅 Mañana', tarde: '☀️ Tarde', noche: '🌙 Noche' }
const METHOD_LABEL: Record<string, string> = { recuerdo: 'Recuerdo activo', feynman: 'Feynman', flashcards: 'Flashcards', intercalado: 'Intercalado', repaso: 'Repaso' }
function planLine(p: ExportPlanItem): string {
  const slot = SLOT_LABEL[p.slot] ?? p.slot
  const method = METHOD_LABEL[p.method] ?? p.method
  const course = p.course ? `${p.course} — ` : ''
  const mins = p.minutes ? ` (${p.minutes} min)` : ''
  const reason = p.reason ? ` — _${p.reason}_` : ''
  return `- ${slot ? `${slot} · ` : ''}${course}${p.topic}${method ? ` · ${method}` : ''}${mins}${reason}`
}

// Contenido del bloque gestionado de la nota diaria (lo de HOY).
function dailyBlockBody(today: string, events: ExportEvent[], tasks: ExportTask[], plan: ExportPlanItem[], brief: string | null): string {
  const todays = events.filter(e => e.date === today)
  // Pendientes para hoy: sin fecha, o con fecha ≤ hoy (vencidas/de hoy).
  const due = tasks.filter(t => !t.done && (!t.date || t.date <= today))
  const lines: string[] = [`## 📅 Hoy · ${today}`, '']
  if (brief) lines.push(`> 🧭 ${brief}`, '')
  lines.push('### Eventos')
  lines.push(todays.length ? todays.map(e => `- ${e.text}`).join('\n') : '_Sin eventos hoy._')
  lines.push('', '### Tareas para hoy')
  lines.push(due.length ? due.map(t => `- [ ] ${t.text}${t.date ? ` 📅 ${t.date}` : ''}`).join('\n') : '_Nada pendiente para hoy._')
  // Plan de Phil (Life Planner). Solo aparece si el usuario lo usa.
  if (plan.length) {
    lines.push('', '### 🧭 Plan de estudio de Phil')
    lines.push(plan.map(planLine).join('\n'))
  }
  return lines.join('\n')
}

// Inserta o reemplaza el bloque gestionado, conservando lo que el usuario escriba fuera.
function upsertManagedBlock(content: string, body: string): string {
  const wrapped = `${ORG_START}\n${body}\n${ORG_END}`
  const re = new RegExp(`${ORG_START}[\\s\\S]*?${ORG_END}`)
  if (re.test(content)) return content.replace(re, wrapped)
  return (content.trim() ? content.trimEnd() + '\n\n' : '') + wrapped + '\n'
}

// ── hash estable de un string (djb2 → base36) ──────────────────────────────
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ── nombres seguros para archivos/carpetas ─────────────────────────────────
function safeName(s: string, fallback: string): string {
  const clean = (s || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.slice(0, 80) || fallback
}
// Nombre de archivo seguro conservando la extensión.
function safeFileName(s: string, fallback: string): string {
  const clean = (s || '').replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim()
  return clean.slice(0, 90) || fallback
}
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

// ── frontmatter ────────────────────────────────────────────────────────────
function splitFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { fm: {}, body: content }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  return { fm, body: content.slice(m[0].length) }
}

// ── HTML (carpetas) → Markdown ─────────────────────────────────────────────
function htmlToMarkdown(html: string): string {
  // DOMParser (no innerHTML-setter) para cumplir las guidelines de la store.
  const root = new DOMParser().parseFromString(html || '', 'text/html').body

  const childInline = (el: HTMLElement): string => Array.from(el.childNodes).map(inline).join('')
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/​/g, '')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as HTMLElement
    const inner = childInline(el)
    switch (el.tagName) {
      case 'STRONG': case 'B': return inner.trim() ? `**${inner}**` : inner
      case 'EM': case 'I': return inner.trim() ? `*${inner}*` : inner
      case 'CODE': return `\`${inner}\``
      case 'BR': return '\n'
      case 'A': { const href = el.getAttribute('href'); return href ? `[${inner}](${href})` : inner }
      case 'IMG': {
        const lp = el.getAttribute('data-localpath')
        if (lp) return `![[${lp}]]`                       // imagen ya descargada al vault
        const src = el.getAttribute('src') || ''; const alt = el.getAttribute('alt') || 'imagen'
        return src && !src.startsWith('blob:') ? `![${alt}](${src})` : ''   // blob: = no recuperable
      }
      default: return inner
    }
  }

  const lines: string[] = []
  const push = (s: string) => { lines.push(s); lines.push('') }

  const listToMd = (listEl: HTMLElement, ordered: boolean, depth: number) => {
    let n = 1
    for (const li of Array.from(listEl.children)) {
      if (li.tagName !== 'LI') continue
      const liEl = li as HTMLElement
      const nested = Array.from(liEl.children).filter(c => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement[]
      const ownText = childInline(liEl).replace(/\n/g, ' ').trim()
      lines.push(`${'  '.repeat(depth)}${ordered ? `${n}.` : '-'} ${ownText}`)
      for (const sub of nested) listToMd(sub, sub.tagName === 'OL', depth + 1)
      n++
    }
  }
  const tableToMd = (table: HTMLElement) => {
    const rows = Array.from(table.querySelectorAll('tr'))
    if (!rows.length) return
    const cellText = (c: Element) => childInline(c as HTMLElement).replace(/\n/g, ' ').trim() || ' '
    rows.forEach((row, i) => {
      const cells = Array.from(row.querySelectorAll('th,td')).map(cellText)
      lines.push(`| ${cells.join(' | ')} |`)
      if (i === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
    })
  }

  const walk = (el: HTMLElement) => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').replace(/​/g, '').trim(); if (t) push(t); continue }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const e = node as HTMLElement
      const tag = e.tagName
      if (/^H[1-6]$/.test(tag)) { push(`${'#'.repeat(Number(tag[1]))} ${childInline(e).trim()}`); continue }
      if (tag === 'HR' || e.classList.contains('ms-hr')) { push('---'); continue }
      if (tag === 'UL' || tag === 'OL') { listToMd(e, tag === 'OL', 0); lines.push(''); continue }
      if (tag === 'TABLE') { tableToMd(e); lines.push(''); continue }
      if (tag === 'BLOCKQUOTE') { push('> ' + childInline(e).trim().replace(/\n/g, '\n> ')); continue }
      if (e.classList.contains('ms-check')) {
        const checked = e.getAttribute('data-checked') === 'true'
        const txt = (e.querySelector('.ms-check-text')?.textContent || '').replace(/​/g, '').trim()
        push(`- [${checked ? 'x' : ' '}] ${txt}`); continue
      }
      if (e.classList.contains('ms-pdf-chip')) { push(`📄 ${(e.getAttribute('data-msname') || e.textContent || 'PDF').trim()}`); continue }
      if (tag === 'DIV' || tag === 'P') {
        if (e.querySelector(':scope > ul, :scope > ol, :scope > table, :scope > div, :scope > h1, :scope > h2, :scope > h3')) { walk(e); continue }
        push(childInline(e).replace(/\n{2,}/g, '\n').trimEnd()); continue
      }
      if (tag === 'IMG') { const s = inline(e).trim(); if (s) push(s); continue }
      const md = childInline(e).trim(); if (md) push(md)
    }
  }

  walk(root)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export default class MiStudioSyncPlugin extends Plugin {
  settings: MiStudioSettings = DEFAULTS
  private timer: number | null = null

  async onload() {
    await this.loadSettings()
    this.addRibbonIcon('refresh-cw', 'Sincronizar con MiStudio', () => this.syncNow())
    this.addCommand({ id: 'mistudio-sync-now', name: 'Sincronizar con MiStudio ahora', callback: () => this.syncNow() })
    this.addCommand({
      id: 'mistudio-send-note',
      name: 'Enviar esta nota a MiStudio (carpeta nueva o existente)',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension !== 'md') return false
        if (!checking) this.sendNoteToMiStudio(file)
        return true
      },
    })
    this.addSettingTab(new MiStudioSettingTab(this.app, this))
    this.scheduleAuto()
  }
  onunload() { if (this.timer !== null) window.clearInterval(this.timer) }

  scheduleAuto() {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null }
    const mins = Math.max(0, Math.floor(this.settings.autoSyncMinutes || 0))
    if (mins > 0) { this.timer = window.setInterval(() => this.syncNow(true), mins * 60_000); this.registerInterval(this.timer) }
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()) }
  async saveSettings() { await this.saveData(this.settings); this.scheduleAuto() }

  private token(): string { return (this.settings.apiKey || this.settings.accessToken || '').trim() }

  async syncNow(silent = false) {
    const token = this.token()
    if (!token) { new Notice('MiStudio: falta la API key (Ajustes del plugin).'); return }
    const root = this.settings.baseUrl.replace(/\/$/, '')
    if (!silent) new Notice('MiStudio: sincronizando…')

    // 1) Traer el estado remoto.
    let res: ExportResponse
    try {
      const r = await requestUrl({ url: `${root}/api/obsidian/export?date=${todayLocalISO()}`, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, throw: false })
      if (r.status === 401) { new Notice('MiStudio: clave inválida o caducada.'); return }
      if (r.status >= 400) { new Notice(`MiStudio: error ${r.status}.`); return }
      res = r.json as ExportResponse
    } catch (err) { new Notice('MiStudio: no se pudo conectar (revisa la URL).'); console.error('[MiStudio Sync]', err); return }
    if (!res?.ok || !Array.isArray(res.folders)) { new Notice('MiStudio: respuesta inesperada.'); return }

    const baseDir = normalizePath(safeName(this.settings.targetFolder, 'MiStudio'))
    await this.ensureFolder(baseDir)

    // Mapa mistudio_id → archivo existente, en TODO el vault (para sobrevivir
    // renombres y reconocer notas enviadas con "Enviar esta nota a MiStudio",
    // que pueden vivir fuera de la carpeta destino → así no se duplican).
    const idToFile = new Map<string, TFile>()
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.mistudio_id
      if (id) { idToFile.set(String(id), f); continue }
      if (!f.path.startsWith(baseDir + '/')) continue
      try {
        const { fm } = splitFrontmatter(await this.app.vault.cachedRead(f))
        if (fm.mistudio_id) idToFile.set(fm.mistudio_id, f)
      } catch { /* ignore */ }
    }

    const journal = this.settings.journal || {}
    const pushes: Array<{ folderId: string; entryId: string; markdown: string }> = []
    let pulled = 0, conflicts = 0

    // Sync selectivo: si hay una lista de carpetas elegidas, ignora el resto.
    const onlyFolders = this.settings.syncFolders || []
    for (const folder of res.folders) {
      if (onlyFolders.length && !onlyFolders.includes(folder.id)) continue
      const folderDir = normalizePath(`${baseDir}/${safeName(folder.name, folder.id)}`)
      await this.ensureFolder(folderDir)
      for (const entry of folder.entries) {
        // Descargar imágenes al vault y reescribir los <img> antes de convertir.
        const leftHtml = await this.resolveImages(entry.contentHtml, baseDir, root, token)
        const rightHtml = folder.layout === 'filofax' ? await this.resolveImages(entry.contentRightHtml, baseDir, root, token) : ''
        const remoteMd = htmlToMarkdown(leftHtml) + (rightHtml ? `\n\n---\n\n${htmlToMarkdown(rightHtml)}` : '')
        const hRemote = hashStr(remoteMd)
        const existing = idToFile.get(entry.id)
        const fmBlock = this.frontmatter(folder, entry)

        if (!existing) {
          const title = safeName(entry.title, entry.createdAt ? entry.createdAt.slice(0, 10) : entry.id)
          await this.writeFile(normalizePath(`${folderDir}/${title}.md`), fmBlock + remoteMd)
          journal[entry.id] = hRemote; pulled++
          continue
        }

        const raw = await this.app.vault.read(existing)
        const localMd = splitFrontmatter(raw).body.trim() + '\n'
        const hLocal = hashStr(localMd)
        if (hLocal === hRemote) { journal[entry.id] = hRemote; continue }   // ya en sync

        const base = journal[entry.id]
        const localChanged = base !== undefined && hLocal !== base
        const remoteChanged = base === undefined || hRemote !== base
        // No subimos notas con imágenes: el embed `![[…]]` no se puede reconvertir
        // a la referencia de Storage → se perdería la imagen en MiStudio. Esas
        // notas quedan pull-only (se conserva tu edición local, no se sube).
        const hasImages = /!\[\[|!\[[^\]]*\]\(/.test(localMd)
        const canPush = this.settings.twoWay && folder.layout !== 'filofax' && !hasImages

        if (localChanged && !remoteChanged) {
          if (canPush) {
            pushes.push({ folderId: folder.id, entryId: entry.id, markdown: localMd })
            journal[entry.id] = hLocal
          } // si no se puede subir, se conserva el archivo local sin tocar
        } else if (localChanged && remoteChanged) {
          // conflicto → respaldar local, bajar remoto (nada se pierde)
          if (this.settings.twoWay) {
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
            const cp = normalizePath(`${existing.parent?.path || folderDir}/${existing.basename}.conflict-${stamp}.md`)
            await this.writeFile(cp, raw); conflicts++
          }
          await this.app.vault.modify(existing, fmBlock + remoteMd)
          journal[entry.id] = hRemote; pulled++
        } else {
          // solo remoto cambió (o no se puede push) → bajar remoto
          await this.app.vault.modify(existing, fmBlock + remoteMd)
          journal[entry.id] = hRemote; pulled++
        }
      }
    }

    // 2) Subir lo editado en Obsidian (two-way).
    let pushed = 0
    if (pushes.length) {
      try {
        const r = await requestUrl({
          url: `${root}/api/obsidian/import`, method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: pushes }), throw: false,
        })
        if (r.status < 400) pushed = (r.json?.applied as number) ?? pushes.length
        else new Notice(`MiStudio: error ${r.status} al subir cambios.`)
      } catch (err) { new Notice('MiStudio: no se pudieron subir los cambios.'); console.error('[MiStudio Sync] push', err) }
    }

    // 3) Tareas, calendario y nota diaria (Life Planner ↔ Obsidian).
    let organizer = ''
    try { organizer = await this.writeOrganizer(res, baseDir, root, token) } catch (e) { console.error('[MiStudio Sync] organizer', e) }

    this.settings.journal = journal
    await this.saveSettings()
    new Notice(`MiStudio: ${pulled} bajada(s), ${pushed} subida(s)${conflicts ? `, ${conflicts} conflicto(s)` : ''}${organizer}.`)
  }

  // Escribe Tareas.md, Calendario.md y la nota diaria según los ajustes.
  // Reconcilia el check de cada tarea (two-way) antes de regenerar el archivo.
  // Devuelve un sufijo para el Notice (ej: ", tareas+diario") o ''.
  private async writeOrganizer(res: ExportResponse, baseDir: string, root: string, token: string): Promise<string> {
    const tasks = Array.isArray(res.tasks) ? res.tasks : []
    const events = Array.isArray(res.events) ? res.events : []
    const did: string[] = []

    if (this.settings.syncTasks) {
      const tasksPath = normalizePath(`${baseDir}/Tareas.md`)

      // Estado local actual (checks que el usuario marcó/desmarcó en el vault).
      let localDone = new Map<string, boolean>()
      const existing = this.app.vault.getAbstractFileByPath(tasksPath)
      if (existing instanceof TFile) {
        try { localDone = parseTaskChecks(await this.app.vault.read(existing)) } catch { /* archivo nuevo */ }
      }

      // Reconciliación por tarea (mismo criterio que las carpetas: gana remoto si
      // ambos cambiaron). Solo participan las tareas con id estable.
      const journal = this.settings.taskJournal || {}
      const toggles: Array<{ id: string; done: boolean }> = []
      for (const t of tasks) {
        if (!t.id) continue
        const base = journal[t.id]
        const local = localDone.has(t.id) ? localDone.get(t.id)! : undefined
        let resolved = t.done
        if (this.settings.twoWay && local !== undefined && base !== undefined && local !== base && t.done === base) {
          toggles.push({ id: t.id, done: local }); resolved = local   // cambió solo en Obsidian → subir
        }
        t.done = resolved          // refleja el estado resuelto en el archivo
        journal[t.id] = resolved
      }
      // Olvida ids que ya no existen para no inflar el journal.
      const present = new Set(tasks.filter(t => t.id).map(t => t.id as string))
      for (const id of Object.keys(journal)) if (!present.has(id)) delete journal[id]
      this.settings.taskJournal = journal

      // Subir los checks cambiados localmente.
      if (toggles.length) {
        try {
          const r = await requestUrl({
            url: `${root}/api/obsidian/tasks`, method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ toggles }), throw: false,
          })
          if (r.status >= 400) new Notice(`MiStudio: error ${r.status} al subir tareas.`)
        } catch (e) { console.error('[MiStudio Sync] tasks push', e) }
      }

      await this.writeFile(tasksPath, tasksMarkdown(tasks))
      await this.writeFile(normalizePath(`${baseDir}/Calendario.md`), calendarMarkdown(events))
      did.push(toggles.length ? `tareas↑${toggles.length}` : 'tareas')
    }

    if (this.settings.dailyNote) {
      const today = todayLocalISO()
      const dir = normalizePath(`${baseDir}/Diario`)
      await this.ensureFolder(dir)
      const path = normalizePath(`${dir}/${today}.md`)
      const plan = Array.isArray(res.plan) ? res.plan : []
      const brief = typeof res.brief === 'string' ? res.brief : null
      const body = dailyBlockBody(today, events, tasks, plan, brief)
      const existing = this.app.vault.getAbstractFileByPath(path)
      if (existing instanceof TFile) {
        const raw = await this.app.vault.read(existing)
        await this.app.vault.modify(existing, upsertManagedBlock(raw, body))
      } else {
        await this.writeFile(path, `# ${today}\n\n${ORG_START}\n${body}\n${ORG_END}\n`)
      }
      did.push('diario')
    }

    return did.length ? `, ${did.join('+')}` : ''
  }

  private frontmatter(folder: ExportFolder, entry: ExportEntry): string {
    return [
      '---',
      `mistudio_id: ${entry.id}`,
      `mistudio_folder_id: ${folder.id}`,
      `mistudio_folder: ${JSON.stringify(folder.name)}`,
      `title: ${JSON.stringify(entry.title || '')}`,
      'type: nota', 'source: mistudio',
      entry.createdAt ? `created: ${entry.createdAt}` : null,
      `synced: ${new Date().toISOString()}`,
      '---', '',
    ].filter(Boolean).join('\n')
  }

  // Descarga las imágenes referenciadas (data-msfile en Storage, data: base64 o
  // http) a `<baseDir>/_adjuntos/` y marca cada <img> con data-localpath para que
  // el conversor emita un embed `![[…]]`. Las blob: no se pueden recuperar.
  private async resolveImages(html: string, baseDir: string, root: string, token: string): Promise<string> {
    if (!html || !/<img/i.test(html)) return html || ''
    // DOMParser (no innerHTML-setter) para cumplir las guidelines de la store.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const imgs = Array.from(doc.querySelectorAll('img'))
    if (!imgs.length) return html
    const attDir = normalizePath(`${baseDir}/_adjuntos`)
    let ensured = false
    for (const img of imgs) {
      const ref = img.getAttribute('data-msfile') || ''
      const src = img.getAttribute('src') || ''
      try {
        let bytes: ArrayBuffer | null = null
        let name = ''
        if (ref) {
          name = safeFileName(ref.split('/').pop() || '', `img-${hashStr(ref)}.png`)
          const local = normalizePath(`${attDir}/${name}`)
          if (this.app.vault.getAbstractFileByPath(local)) { img.setAttribute('data-localpath', local); continue }
          const sig = await requestUrl({ url: `${root}/api/obsidian/file?ref=${encodeURIComponent(ref)}`, headers: { Authorization: `Bearer ${token}` }, throw: false })
          if (sig.status >= 400 || !sig.json?.url) continue
          const f = await requestUrl({ url: sig.json.url as string, throw: false })
          bytes = f.arrayBuffer
        } else if (src.startsWith('data:')) {
          const m = src.match(/^data:([^;]+);base64,(.*)$/)
          if (!m) continue
          name = `img-${hashStr(src).slice(0, 10)}.${(m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')}`
          bytes = base64ToArrayBuffer(m[2])
        } else if (/^https?:/i.test(src)) {
          name = safeFileName((src.split('/').pop() || '').split('?')[0], `img-${hashStr(src)}.png`)
          const f = await requestUrl({ url: src, throw: false })
          bytes = f.arrayBuffer
        } else {
          continue   // blob: u otro → no recuperable
        }
        if (!bytes || !name) continue
        if (!ensured) { await this.ensureFolder(attDir); ensured = true }
        const local = normalizePath(`${attDir}/${name}`)
        const existing = this.app.vault.getAbstractFileByPath(local)
        if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes)
        else await this.app.vault.createBinary(local, bytes)
        img.setAttribute('data-localpath', local)
      } catch (e) { console.error('[MiStudio Sync] imagen', e) }
    }
    return doc.body.innerHTML
  }

  // Enviar la nota ACTIVA a MiStudio (acción explícita del usuario). Abre un
  // selector: crear carpeta nueva, o añadirla como entrada de una existente.
  async sendNoteToMiStudio(file: TFile) {
    const token = this.token()
    if (!token) { new Notice('MiStudio: falta la API key (Ajustes del plugin).'); return }
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.mistudio_id) {
      new Notice('Esta nota ya está sincronizada con MiStudio.'); return
    }
    const root = this.settings.baseUrl.replace(/\/$/, '')
    let folders: ExportFolder[] = []
    try {
      const r = await requestUrl({ url: `${root}/api/obsidian/export`, headers: { Authorization: `Bearer ${token}` }, throw: false })
      if (r.status === 401) { new Notice('MiStudio: clave inválida.'); return }
      if (r.status >= 400) { new Notice(`MiStudio: error ${r.status}.`); return }
      folders = ((r.json as ExportResponse)?.folders) ?? []
    } catch { new Notice('MiStudio: no se pudo conectar.'); return }

    const title = file.basename
    new SendNoteModal(this.app, folders, title, async (choice) => {
      const raw = await this.app.vault.read(file)
      const md = splitFrontmatter(raw).body.trim()
      if (!md) { new Notice('La nota está vacía.'); return }
      const payload: { title: string; markdown: string; folderId?: string; newFolderName?: string } = { title, markdown: md }
      if (choice.kind === 'existing') payload.folderId = choice.id
      else payload.newFolderName = title

      let resp: { ok?: boolean; folderId?: string; entryId?: string } | null = null
      try {
        const r = await requestUrl({
          url: `${root}/api/obsidian/create`, method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), throw: false,
        })
        if (r.status >= 400) { new Notice(`MiStudio: error ${r.status} al crear.`); return }
        resp = r.json
      } catch { new Notice('MiStudio: no se pudo crear.'); return }
      if (!resp?.ok || !resp.entryId || !resp.folderId) { new Notice('MiStudio: respuesta inesperada.'); return }

      // Marcar la nota como sincronizada → desde aquí funciona el two-way normal.
      try {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          fm.mistudio_id = resp!.entryId
          fm.mistudio_folder_id = resp!.folderId
          fm.source = 'mistudio'
          fm.synced = new Date().toISOString()
        })
      } catch (e) { console.error('[MiStudio Sync] frontmatter', e) }
      this.settings.journal[resp.entryId] = hashStr(md + '\n')
      await this.saveSettings()
      new Notice(choice.kind === 'existing' ? `Añadida a ${choice.name} en MiStudio.` : `Carpeta «${title}» creada en MiStudio.`)
    }).open()
  }

  // Lista de carpetas remotas (para el selector de "sync selectivo" en ajustes).
  async fetchFolders(): Promise<ExportFolder[]> {
    const token = this.token()
    if (!token) { new Notice('MiStudio: falta la API key (Ajustes del plugin).'); return [] }
    const root = this.settings.baseUrl.replace(/\/$/, '')
    try {
      const r = await requestUrl({ url: `${root}/api/obsidian/export`, headers: { Authorization: `Bearer ${token}` }, throw: false })
      if (r.status >= 400) { new Notice(`MiStudio: error ${r.status}.`); return [] }
      return ((r.json as ExportResponse)?.folders) ?? []
    } catch { new Notice('MiStudio: no se pudo conectar (revisa la URL).'); return [] }
  }

  private async ensureFolder(path: string) {
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFolder) return
    if (!existing) { try { await this.app.vault.createFolder(path) } catch { /* carrera */ } }
  }
  private async writeFile(path: string, content: string) {
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) await this.app.vault.modify(existing, content)
    else await this.app.vault.create(path, content)
  }
}

class MiStudioSettingTab extends PluginSettingTab {
  plugin: MiStudioSyncPlugin
  private folders: ExportFolder[] = []
  constructor(app: App, plugin: MiStudioSyncPlugin) { super(app, plugin); this.plugin = plugin }

  // Render de los toggles por carpeta para el sync selectivo.
  private renderFolderList(el: HTMLElement): void {
    el.empty()
    if (!this.folders.length) {
      el.createEl('p', { text: 'Pulsa “Cargar carpetas” para elegir cuáles sincronizar. Vacío = todas.', cls: 'setting-item-description' })
      return
    }
    const sel = this.plugin.settings.syncFolders
    const isOn = (id: string) => sel.length === 0 || sel.includes(id)
    for (const f of this.folders) {
      new Setting(el).setName(f.name).addToggle(t => t.setValue(isOn(f.id)).onChange(async v => {
        let cur = this.plugin.settings.syncFolders.length === 0 ? this.folders.map(x => x.id) : [...this.plugin.settings.syncFolders]
        if (v) { if (!cur.includes(f.id)) cur.push(f.id) } else { cur = cur.filter(x => x !== f.id) }
        // Si quedan todas seleccionadas, guardamos [] (= todas).
        this.plugin.settings.syncFolders = cur.length === this.folders.length ? [] : cur
        await this.plugin.saveSettings()
      }))
    }
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    new Setting(containerEl).setName('MiStudio Sync').setHeading()
    containerEl.createEl('p', { text: 'Trae tus carpetas de MiStudio a este vault. Genera la API key en {tu MiStudio}/obsidian.', cls: 'setting-item-description' })

    new Setting(containerEl).setName('URL de MiStudio').setDesc('Por defecto la app oficial. Cámbiala solo si usas un dominio propio.')
      .addText(t => t.setPlaceholder('https://mistudiostudy.vercel.app').setValue(this.plugin.settings.baseUrl)
        .onChange(async v => { this.plugin.settings.baseUrl = v.trim(); await this.plugin.saveSettings() }))

    new Setting(containerEl).setName('API key').setDesc('Pega la clave mist_… generada en {URL}/obsidian. No caduca.')
      .addText(t => { t.setPlaceholder('mist_…').setValue(this.plugin.settings.apiKey)
        .onChange(async v => { this.plugin.settings.apiKey = v.trim(); await this.plugin.saveSettings() }); t.inputEl.type = 'password'; return t })

    new Setting(containerEl).setName('Carpeta destino').setDesc('Subcarpeta del vault donde se guardan los apuntes.')
      .addText(t => t.setPlaceholder('MiStudio').setValue(this.plugin.settings.targetFolder)
        .onChange(async v => { this.plugin.settings.targetFolder = v.trim() || 'MiStudio'; await this.plugin.saveSettings() }))

    new Setting(containerEl).setName('Sincronización bidireccional (two-way)')
      .setDesc('Sube a MiStudio lo que edites en Obsidian. Si ambos lados cambian, gana MiStudio y tu versión se guarda como .conflict. Las carpetas filofax son solo de bajada.')
      .addToggle(t => t.setValue(this.plugin.settings.twoWay)
        .onChange(async v => { this.plugin.settings.twoWay = v; await this.plugin.saveSettings() }))

    new Setting(containerEl).setName('Sincronizar tareas y calendario')
      .setDesc('Genera Tareas.md (checkboxes compatibles con el plugin Tasks) y Calendario.md desde tu Workspace. Si la sincronización two-way está activa, marcar/desmarcar una tarea en Tareas.md actualiza tu To-Do en MiStudio.')
      .addToggle(t => t.setValue(this.plugin.settings.syncTasks)
        .onChange(async v => { this.plugin.settings.syncTasks = v; await this.plugin.saveSettings() }))

    new Setting(containerEl).setName('Nota diaria')
      .setDesc('Crea/actualiza Diario/AAAA-MM-DD.md con los eventos y tareas de hoy. Solo toca un bloque delimitado: lo que escribas fuera de él se conserva.')
      .addToggle(t => t.setValue(this.plugin.settings.dailyNote)
        .onChange(async v => { this.plugin.settings.dailyNote = v; await this.plugin.saveSettings() }))

    // ── Sync selectivo por carpeta ──
    const folderSection = containerEl.createDiv()
    new Setting(folderSection).setName('Carpetas a sincronizar')
      .setDesc('Vacío = todas. Carga la lista y elige cuáles bajar al vault.')
      .addButton(b => b.setButtonText(this.folders.length ? 'Recargar' : 'Cargar carpetas')
        .onClick(async () => {
          b.setButtonText('Cargando…'); b.setDisabled(true)
          this.folders = await this.plugin.fetchFolders()
          b.setButtonText('Recargar'); b.setDisabled(false)
          this.renderFolderList(listEl)
        }))
    const listEl = folderSection.createDiv()
    this.renderFolderList(listEl)

    new Setting(containerEl).setName('Auto-sincronizar cada (minutos)').setDesc('0 = solo manual. Sugerido: 15–30.')
      .addText(t => t.setPlaceholder('0').setValue(String(this.plugin.settings.autoSyncMinutes))
        .onChange(async v => { this.plugin.settings.autoSyncMinutes = Math.max(0, Math.floor(Number(v) || 0)); await this.plugin.saveSettings() }))

    new Setting(containerEl).setName('Sincronizar ahora')
      .addButton(b => b.setButtonText('Sincronizar').setCta().onClick(() => this.plugin.syncNow()))

    containerEl.createEl('p', {
      text: 'Para enviar una nota nueva de Obsidian a MiStudio: ábrela y usa el comando “Enviar esta nota a MiStudio”.',
      cls: 'setting-item-description',
    })
  }
}

// ── Selector: a qué carpeta de MiStudio mandar la nota (o crear una nueva) ──
interface SendChoice { kind: 'new' | 'existing'; id?: string; name: string }

class SendNoteModal extends FuzzySuggestModal<SendChoice> {
  private items: SendChoice[]
  private onPick: (c: SendChoice) => void
  constructor(app: App, folders: ExportFolder[], title: string, onPick: (c: SendChoice) => void) {
    super(app)
    this.onPick = onPick
    this.items = [
      { kind: 'new', name: `➕ Crear carpeta nueva: «${title}»` },
      ...folders.map(f => ({ kind: 'existing' as const, id: f.id, name: `📁 ${f.name}` })),
    ]
    this.setPlaceholder('Elige dónde guardar esta nota en MiStudio…')
  }
  getItems(): SendChoice[] { return this.items }
  getItemText(item: SendChoice): string { return item.name }
  onChooseItem(item: SendChoice): void { this.onPick(item) }
}

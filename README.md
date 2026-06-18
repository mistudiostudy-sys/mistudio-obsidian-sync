# MiStudio Sync — plugin de Obsidian

Sincroniza tus **carpetas y apuntes de MiStudio** con tu vault de Obsidian.
Obsidian actúa de **cliente**: jala el contenido y (opcional) sube de vuelta lo
que edites.

- **Bajada (siempre):** MiStudio → archivos `.md` en tu vault.
- **Subida (opcional, “two-way”):** lo que edites en Obsidian vuelve a MiStudio.
- **Tareas + calendario + nota diaria (opcional):** tu To-Do y tu calendario de
  MiStudio se vuelven `Tareas.md` / `Calendario.md`, y una **nota diaria** reúne
  lo de hoy. Tu Life Planner y tu vault, en el mismo flujo.
- **API key de larga duración** (no caduca), generada en `{tu-MiStudio}/obsidian`.

Cada apunte lleva frontmatter (`mistudio_id`, `mistudio_folder_id`, `created`,
`synced`) para reconocerlo entre sync y no duplicar.

---

## Instalación paso a paso

### 1. Generar la API key en MiStudio
1. Entra a MiStudio en tu navegador (logueado) y abre **`https://mistudiostudy.vercel.app/obsidian`**.
2. Clic en **“Generar nueva API key”**.
3. **Copia la clave `mist_…`** que aparece (solo se muestra una vez).

### 2. Compilar el plugin
> Necesitas Node.js instalado.

```bash
git clone https://github.com/mistudiostudy-sys/mistudio-obsidian-sync.git
cd mistudio-obsidian-sync
npm install
npm run build      # genera main.js
```

### 3. Copiarlo a tu vault
1. Crea la carpeta: `<tu-vault>/.obsidian/plugins/mistudio-sync/`
   *(la carpeta `.obsidian` está oculta; actívala en tu explorador de archivos).*
2. Copia ahí estos 2 archivos: **`manifest.json`** y **`main.js`**.

### 4. Activarlo en Obsidian
1. Obsidian → **Ajustes → Plugins de la comunidad**.
2. Si hace falta, desactiva el **Modo restringido** (*Restricted mode → Turn off*).
3. En **“Plugins instalados”**, activa **“MiStudio Sync”**.

### 5. Configurarlo
En **Ajustes → MiStudio Sync**:
- **URL de MiStudio**: `https://mistudiostudy.vercel.app` (o tu dominio propio).
- **API key**: pega la clave `mist_…` del paso 1.
- **Carpeta destino**: `MiStudio` (o la que prefieras).
- **Sincronización bidireccional (two-way)**: actívala si quieres que tus
  ediciones en Obsidian vuelvan a MiStudio.
- **Sincronizar tareas y calendario**: genera `Tareas.md` (checkboxes
  compatibles con el plugin **Tasks**: `- [ ] tarea 📅 2026-06-20`) y
  `Calendario.md` desde tu Workspace. Son **vistas de solo lectura**: se
  reescriben en cada sincronización.
- **Nota diaria**: crea/actualiza `Diario/AAAA-MM-DD.md` con los eventos y tareas
  de hoy. Solo toca un bloque delimitado (`<!-- mistudio:start … end -->`): lo
  que escribas fuera de él se conserva.
- **Carpetas a sincronizar**: pulsa *Cargar carpetas* y marca cuáles bajar.
  Vacío (todas marcadas) = sincroniza todo. Útil si solo quieres algunas en el vault.
- **Auto-sincronizar cada N minutos**: `0` = solo manual; `15`–`30` recomendado.

### 6. Sincronizar
Pulsa el icono **🔄** de la cinta izquierda, o abre la paleta de comandos
(`Ctrl/Cmd+P`) → **“Sincronizar con MiStudio ahora”**.
Verás un aviso tipo *“X bajada(s), Y subida(s)”*.

---

## Enviar una nota de Obsidian a MiStudio (opt-in)

Una nota creada en Obsidian **no** se sube sola. Cuando tú quieras:

1. Abre la nota.
2. Paleta de comandos (`Ctrl/Cmd+P`) → **“Enviar esta nota a MiStudio (carpeta
   nueva o existente)”**.
3. Elige en el selector:
   - **➕ Crear carpeta nueva** (con el título de la nota), o
   - **📁 una carpeta existente** → la nota entra como **nueva entrada** ahí.

La nota queda marcada (frontmatter `mistudio_id`) y desde entonces participa del
two-way normal como cualquier apunte sincronizado.

## Cómo resuelve conflictos (two-way)

Por cada apunte recuerda el último estado sincronizado (un hash):
- **Solo cambió en MiStudio** → se baja al vault.
- **Solo cambió en Obsidian** → se sube a MiStudio.
- **Cambió en ambos** → gana **MiStudio**, y tu versión local se guarda como
  `nombre.conflict-AAAA-MM-DD-HHmm.md`. **Nada se borra en silencio.**

## Imágenes

Al bajar, las imágenes de tus carpetas se descargan a
`<carpeta destino>/_adjuntos/` y se enlazan con un embed `![[…]]`, así se ven
dentro de Obsidian. (Las imágenes pegadas como `blob:` sin respaldo en Storage
no se pueden recuperar.)

## Tareas, calendario y nota diaria (Life Planner ↔ Obsidian)

Actívalos en **Ajustes → MiStudio Sync**. En cada sincronización:

- `Tareas.md` — todas tus tareas del To-Do como checkboxes; las que tienen fecha
  llevan `📅 AAAA-MM-DD`, compatible con el plugin **Tasks** y con Dataview.
- `Calendario.md` — tus eventos agrupados por fecha.
- `Diario/AAAA-MM-DD.md` — los eventos y tareas **de hoy**, en un bloque
  gestionado; escribe tus propias notas del día alrededor y se conservan.
  Si usas **Phil · Life Planner**, la nota diaria también trae tu **plan de
  estudio de hoy** (qué tema, con qué método y cuántos minutos) y el brief de Phil.

**Marcar tareas (two-way):** con la sincronización **two-way** activa, marcar o
desmarcar una tarea en `Tareas.md` y volver a sincronizar **actualiza tu To-Do en
MiStudio**. Cada tarea lleva un marcador invisible `<!--ms:id-->` que la identifica;
no lo borres. Si una tarea cambió en ambos lados, gana MiStudio. El texto y las
fechas de las tareas siguen siendo de solo lectura (se regeneran desde MiStudio);
edítalos en la app. El `Calendario.md` y la nota diaria son solo de bajada.

## Limitaciones de esta versión (0.8.1)

- **Filofax (dos páginas)**: solo bajada.
- **Tareas**: se devuelve el *check* (`done`); el texto, la fecha y crear/borrar
  tareas se hacen en MiStudio. El calendario es solo de bajada.
- **Notas con imágenes**: en two-way, las ediciones de notas con imágenes no se
  suben (el embed `![[…]]` no se puede reconvertir a la referencia de Storage);
  tu edición local se conserva igual.
- Subir desde Obsidian convierte tu Markdown a HTML del editor: se conservan
  texto, listas, pendientes y tablas, pero formatos finos (colores, resaltados,
  dibujos, stickers) hechos en MiStudio pueden simplificarse.

## Roadmap

- [x] Descargar imágenes al vault.
- [x] Enviar nota de Obsidian → carpeta nueva o entrada en carpeta existente.
- [x] Tareas + calendario + nota diaria (Life Planner ↔ Obsidian).
- [x] Subir el check de una tarea desde Obsidian → MiStudio (tareas two-way).
- [x] Plan diario de Phil dentro de la nota diaria.
- [x] Sync selectivo por carpeta.
- [ ] Crear/editar tareas desde Obsidian → MiStudio.
- [ ] Publicar en la community store (ver `SUBMISSION.md`).
- [ ] PDFs adjuntos al vault.
- [ ] Flashcards de IA Studio → `.md` compatible con Anki.

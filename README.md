# gh-script-lab

Laboratorio práctico de **`actions/github-script`** con versiones actuales (v9 / Node 24).

Construye, por fases, un bot de triage de issues que responde, clasifica, etiqueta y
agrega issues a un board de GitHub Projects v2.

> **Origen del lab.** Este proyecto replica los conceptos del módulo de Microsoft Learn
> [*Automate GitHub by using GitHub Script*](https://learn.microsoft.com/en-us/training/modules/automate-github-using-github-script/),
> cuyo código está congelado en 2019 (`actions/github-script@0.8.0`) y contiene ejemplos que
> hoy no funcionan. Los **conceptos** del módulo siguen siendo válidos; el código no.
> Ver [Anexo: diferencias con el material original](#anexo-diferencias-con-el-material-original).

---

## Índice

- [Qué hace el bot](#qué-hace-el-bot)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Setup](#setup)
- [Conceptos clave](#conceptos-clave)
  - [1. El cliente Octokit preautenticado](#1-el-cliente-octokit-preautenticado)
  - [2. El objeto `context`](#2-el-objeto-context)
  - [3. `permissions`: el token es read-only por defecto](#3-permissions-el-token-es-read-only-por-defecto)
  - [4. El workspace arranca vacío](#4-el-workspace-arranca-vacío)
  - [5. Expresiones `if:` — job vs. step](#5-expresiones-if--job-vs-step)
  - [6. Script injection: la trampa principal](#6-script-injection-la-trampa-principal)
  - [7. Scripts en archivos externos](#7-scripts-en-archivos-externos)
  - [8. Outputs entre steps](#8-outputs-entre-steps)
  - [9. GraphQL y Projects v2](#9-graphql-y-projects-v2)
- [Hardening](#hardening)
  - [Concurrency](#concurrency)
  - [Permisos mínimos por job](#permisos-mínimos-por-job)
  - [Pinning por SHA](#pinning-por-sha)
  - [Retries](#retries)
  - [Aislamiento de credenciales](#aislamiento-de-credenciales)
- [Recorrido por fases](#recorrido-por-fases)
- [Anexo: diferencias con el material original](#anexo-diferencias-con-el-material-original)

---

## Qué hace el bot

Cuando alguien abre una issue:

1. **Detecta si el autor es primerizo** (`github.paginate` sobre sus issues previas).
2. **Comenta** con una plantilla markdown distinta según el caso.
3. **Clasifica** el contenido por palabras clave y aplica una label (`bug`,
   `enhancement`, `question`, `documentation` o `needs-triage`).
4. **Calcula una prioridad** (P1–P4) derivada de la clasificación.
5. **Agrega la issue al board** de Projects v2 y setea el campo `Priority`.

Todo con permisos mínimos, dependencias inmutables y tolerancia a fallos transitorios.

---

## Estructura del repositorio

```
.github/
├── workflows/
│   └── triage.yml                  # el workflow completo
├── scripts/
│   ├── classify.js                 # reglas de clasificación + labels
│   └── add-to-project.js           # mutations GraphQL de Projects v2
├── ISSUE_RESPONSES/
│   ├── welcome.md                  # plantilla estándar
│   └── welcome-first.md            # plantilla para contributors primerizos
└── dependabot.yml                  # actualiza los SHAs de las actions
```

---

## Setup

### Requisitos

- Repositorio con Issues y Projects habilitados.
- `gh` CLI autenticado con scopes `repo`, `workflow`, `project`.

```bash
gh auth refresh -h github.com -s repo,workflow,project
```

### Labels

```bash
gh label create needs-triage --color FBCA04 --description "Pendiente de clasificar"
gh label create question --color D876E3 --force
```

### Project v2

1. Crear un project (plantilla **Board**).
2. Agregar un campo: **Settings → Fields → New field** → nombre `Priority`,
   tipo **Single select**, opciones `P1`…`P4`.

> **Campo ≠ columna.** En Projects v2 las columnas del Board son solo la agrupación
> visual de *un* campo (`Status` por defecto). Un campo nuevo no aparece como columna;
> vive en paralelo. En vista **Table** sí se ven como columnas, porque ahí la metáfora
> coincide.

### Token

El `GITHUB_TOKEN` de Actions **no puede escribir en Projects** — no existe un
`permissions: projects: write`. Los projects viven a nivel de usuario u organización,
fuera del alcance del token efímero del repo.

| Tipo de project | Token que funciona |
|---|---|
| De **organización** | PAT fine-grained (Organization permissions → Projects: RW) |
| De **usuario** | PAT **classic** con scope `project` |

Los fine-grained [no soportan projects de cuenta de usuario](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
— es una limitación documentada por GitHub.

> **Costo a asumir.** Un PAT classic con scope `project` puede leer y escribir en
> **todos** tus projects; no se puede acotar a uno. Por eso conviene una expiración corta.
> En producción la respuesta correcta es una **GitHub App**, que emite tokens de
> instalación de vida corta con permisos acotados y sí soporta Projects.

### Secrets y variables

```bash
gh secret set PROJECTS_TOKEN          # el PAT

gh variable set PROJECT_ID        --body "PVT_..."
gh variable set PRIORITY_FIELD_ID --body "PVTSSF_..."
gh variable set PRIORITY_OPTIONS  --body '{"P1":"...","P2":"...","P3":"...","P4":"..."}'
```

Los node IDs **no son secretos** — son identificadores públicos. Van como *variables*,
que se ven en logs y en la UI. Meter todo en secrets es un antipatrón: dificulta el
debugging sin ganar seguridad.

### Descubrir los node IDs

```bash
gh api graphql -f query='
  query($login: String!, $number: Int!) {
    user(login: $login) {
      projectV2(number: $number) {
        id
        title
        fields(first: 20) {
          nodes {
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }' -f login=TU_USUARIO -F number=1
```

`-f` pasa strings, `-F` pasa tipos nativos. `number` es `Int`, así que va con `-F`;
con `-f` la query falla por tipos.

Los `... on Tipo` son **fragmentos inline**. `fields` devuelve una unión de tipos
(texto, número, fecha, single-select…) y solo `ProjectV2SingleSelectField` tiene
`options`. Sin el fragmento, GraphQL rechaza la query.

---

## Conceptos clave

### 1. El cliente Octokit preautenticado

`github-script` inyecta variables ya definidas en el scope del script. **No hay que
importarlas** — el `script:` es el cuerpo de una función async, no un archivo.

| Variable | Qué es |
|---|---|
| `github` | Cliente Octokit preautenticado, con plugins de paginación y retry |
| `context` | Contexto del workflow run |
| `core` | `@actions/core` — logging, outputs, summaries, anotaciones |
| `glob` | `@actions/glob` |
| `io` | `@actions/io` |
| `exec` | `@actions/exec` |
| `getOctokit` | Factory para crear clientes con **otros** tokens (nuevo en v9) |
| `require` | Wrapper que resuelve rutas relativas al working directory |

El cliente expone tres superficies:

```js
github.rest.issues.createComment({...})   // REST
github.graphql(query, variables)          // GraphQL
github.paginate(opts)                     // REST con paginación automática
```

> **Cambio crítico (v5).** Los métodos REST se movieron bajo `github.rest.*`.
> El módulo de MS Learn usa `github.issues.createComment` — eso **falla** en v5+.

### 2. El objeto `context`

Contiene el payload del webhook más metadatos del run.

```js
context.eventName      // 'issues', 'push', 'workflow_dispatch'...
context.payload        // el webhook COMPLETO del evento
context.actor          // quién lo disparó
context.runId          // id del run
context.serverUrl      // https://github.com
```

Y dos **getters calculados** que no aparecen si haces `JSON.stringify(context)`:

```js
context.repo    // { owner, repo }
context.issue   // { owner, repo, number }
```

**Por qué `context.repo` nunca falla y `context.issue.number` sí:**

```js
get repo() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
  return { owner, repo }
}

get issue() {
  const payload = this.payload
  return {
    ...this.repo,
    number: (payload.issue || payload.pull_request || payload).number
  }
}
```

`repo` lee una **variable de entorno** que el runner siempre define. `issue.number`
depende del payload: si el trigger no trae una issue (ej. `workflow_dispatch`),
devuelve `undefined` **sin lanzar error**. El fallo aparece varias capas después,
en la llamada a la API, con un mensaje confuso.

> **Regla práctica:** el trigger determina qué hay en `context.payload`. Código que
> funciona en `issues.opened` puede romper en `push` porque asume un payload que ese
> evento no entrega.

### 3. `permissions`: el token es read-only por defecto

Desde 2023, el `GITHUB_TOKEN` arranca con permisos de **solo lectura** en repos y
organizaciones nuevas. Sin declararlo, cualquier escritura devuelve:

```
RequestError [HttpError]: Resource not accessible by integration
    status: 403
```

Ese mensaje es específico de tokens de Actions/GitHub Apps sin el scope necesario.
**Cuando lo veas, mira el bloque `permissions:` antes que el código.**

```yaml
permissions:
  contents: read
  issues: write
```

Detalle de diagnóstico: cuando falla por permisos, los `console.log` **sí se ejecutan**.
Si ves tus logs y luego el 403, `context` está bien — el problema es el token.

### 4. El workspace arranca vacío

El runner es una VM limpia. Actions te da el *contexto* del evento vía API, pero
**no clona nada**. Sin `actions/checkout`:

```
cwd = /home/runner/work/gh-script-lab/gh-script-lab
contenido = []
Error: ENOENT: no such file or directory
```

Corolario práctico: **no hagas `checkout` "por si acaso"**. Si el job solo habla con la
API, es tiempo y ancho de banda desperdiciados. Solo cuando tocas archivos del repo.

```yaml
- uses: actions/checkout@v6
  with:
    sparse-checkout: |
      .github/ISSUE_RESPONSES
      .github/scripts
```

> **Cone mode.** `sparse-checkout` usa cone mode por defecto, que **siempre incluye
> todos los archivos del directorio raíz** (por eso aparece el `README.md` aunque no lo
> pidas). El diseño busca que el repo se vea usable — normalmente quieres `package.json`
> o `go.mod` disponibles. Para filtrado estricto: `sparse-checkout-cone-mode: false`,
> a costa de velocidad en repos grandes.

`process.cwd()` equivale a `GITHUB_WORKSPACE`, por eso las rutas relativas funcionan
sin `path.resolve()`.

### 5. Expresiones `if:` — job vs. step

| | `jobs.<id>.if` | `steps[].if` |
|---|---|---|
| Quién evalúa | El **servicio** de Actions, antes de despachar | El **runner**, ya arrancado |
| ¿Provisiona runner? | No | Sí |
| Minutos facturados | 0 | Mínimo 1 (se redondea por job) |
| Contextos disponibles | `github`, `needs`, `vars`, `inputs` | + `env`, `steps`, `job`, `runner`, `matrix` |

**La pregunta correcta no es "¿job o step?" sino "¿cuál es la unidad real de trabajo que
quiero condicionar?"**. Si la condición aplica a todo el job, va en el job. Si aplica a
una parte, va en el step. En este lab está en el step porque el etiquetado debe correr
siempre, aunque el comentario de bienvenida se salte.

Ojo con el efecto cascada: si un job se salta, los jobs que lo declaran en `needs:`
también se saltan, salvo `if: always()` o `!cancelled()`. Es la causa clásica de
"¿por qué no corrió mi deploy?".

#### Errores frecuentes de sintaxis

```yaml
# ❌ Compara un enum contra un login — siempre true, el step nunca se salta
if: github.event.issue.author_association != github.repository_owner

# ✅ Enum contra enum
if: github.event.issue.author_association != 'OWNER'

# ✅ Login contra login
if: github.event.issue.user.login != github.repository_owner
```

- Los **literales de string necesitan comillas simples**. Sin ellas, Actions interpreta
  la palabra como un contexto: `Unrecognized named-value: 'OWNER'`.
- `${{ }}` es **redundante** en `if:` — el campo ya se evalúa como expresión. Excepción:
  si la expresión empieza con `!`, YAML lee ese carácter como etiqueta de tipo y hay que
  envolverla.
- Las comparaciones son **case-insensitive** y hacen coerción de tipos (como `==` de JS).
- Un typo en un literal (`'sucess'` por `'success'`) **no da error**: la condición es
  siempre falsa, el step se salta en silencio y el job sale verde.

Para condiciones largas, usa un bloque plegado:

```yaml
if: >-
  steps.classify.outcome == 'success' &&
  steps.classify.outputs.result != '' &&
  fromJSON(steps.classify.outputs.result).priority != 'P4'
```

El chequeo intermedio de `!= ''` importa: si el step falló, el output está vacío y
`fromJSON('')` revienta la evaluación de la expresión.

**Cómo depurar un `if:` que no filtra.** En la UI, un step saltado sale gris con
*"This step was skipped"*. Si sale verde cuando esperabas gris, la condición fue
verdadera — casi siempre por comparar tipos distintos.

### 6. Script injection: la trampa principal

Este es el hueco de seguridad más importante de `github-script`, y **el módulo de
MS Learn no lo menciona**.

Actions evalúa `${{ }}` como una **sustitución textual**, *antes* de que el script llegue
al motor de JavaScript. Con este código:

```yaml
# ❌ VULNERABLE
script: |
  const title = "${{ github.event.issue.title }}"
```

Una issue titulada `PWN"); console.log("código arbitrario"); console.log("` produce:

```js
const title = "PWN"); console.log("código arbitrario"); console.log("")
```

Tres sentencias donde escribiste una. El atacante no explotó un bug de Node ni de
Octokit: **escribió parte de tu programa** poniendo texto en el título de una issue.

Ni siquiera hace falta malicia: una issue titulada `Fix the "save" button` rompe el
workflow con un `SyntaxError`.

**La solución** — pasar el dato por entorno, donde llega como *dato* y nunca toca el
parser de JS:

```yaml
# ✅ SEGURO
env:
  ISSUE_TITLE: ${{ github.event.issue.title }}
with:
  script: |
    const title = process.env.ISSUE_TITLE || ''
```

El `|| ''` no es decoración: una issue sin cuerpo entrega `null`, y `null.toLowerCase()`
mata el step.

**Campos sospechosos** (todo lo que escribe un humano ajeno): `issue.title`,
`issue.body`, `pull_request.title`, `pull_request.body`, `comment.body`, `head_ref`
(nombre de rama), `commit.message`, `review.body`.

> Aplica igual a `run:` con shell — ahí la inyección es de bash, y la solución es la
> misma: `env:` + `"$VAR"` entre comillas.

**Por qué escala.** En un demo el payload solo hace `console.log`. En un workflow con
`permissions: write` o secrets en el entorno, el mismo hueco permite exfiltrar el
`GITHUB_TOKEN`, crear releases o hacer push. Con trigger `pull_request_target`,
cualquiera en internet puede dispararlo desde un fork — la familia de vulnerabilidades
conocida como *pwn request*.

### 7. Scripts en archivos externos

Pasadas ~20 líneas, el script inline deja de ser mantenible: no se puede testear, no
tiene resaltado de sintaxis y ensucia el YAML.

```yaml
script: |
  const classify = require('.github/scripts/classify.js')
  return await classify({ github, context, core })
```

```js
// .github/scripts/classify.js
module.exports = async ({ github, context, core }) => {
  // ...
  return { label, priority }
}
```

Dos cosas no obvias:

**El `require` no es el de Node.** La action lo envuelve para que resuelva rutas
**relativas al working directory**, no al archivo que llama. Por eso se escribe
`require('.github/scripts/classify.js')` sin `./` ni `path.resolve()`. El mismo wrapper
permite `require('lodash')` si corriste `npm ci` en un step previo. El original está en
`__original_require__`.

**Las variables se pasan explícitamente.** Dentro del `.js` **no existen** `github`,
`context` ni `core`: son parámetros de la función inline, no globales del proceso.
`process.env` **sí** funciona, porque es un global real de Node.

> **Node built-ins vs. paquetes ESM.** `require('fs')`, `require('path')`,
> `require('crypto')` funcionan siempre. Pero `require('@actions/github')` **falla en v9**:
> ese paquete pasó a ser ESM-only y no se puede cargar con `require()` síncrono. Por eso
> v9 inyecta `getOctokit` como parámetro.

**Beneficio real:** `classify.js` es un módulo CommonJS normal. Se le puede escribir un
test con Jest pasándole objetos falsos de `github` y `context`. La lógica dejó de estar
atrapada en YAML.

### 8. Outputs entre steps

El `return` del script se serializa como JSON y queda en `steps.<id>.outputs.result`.

```yaml
- name: Auto-label by content
  id: classify                       # el id es obligatorio
  uses: actions/github-script@v9
  with:
    script: |
      return { label: 'bug', priority: 'P1' }

- name: Report
  env:
    PRIORITY: ${{ fromJSON(steps.classify.outputs.result).priority }}
```

**No es un canal especial** — es el mismo mecanismo de `$GITHUB_OUTPUT`. La action hace
internamente `core.setOutput('result', JSON.stringify(valor))`, y `setOutput` escribe en
el archivo apuntado por `$GITHUB_OUTPUT`:

```
tu return → core.setOutput() → escribe en $GITHUB_OUTPUT
                                        ↓
                     el runner lee el archivo AL TERMINAR el step
                                        ↓
                          publica en steps.<id>.outputs.result
```

Puedes verlo con `fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8')`. Verás un formato
heredoc con delimitador aleatorio — la protección contra inyección en outputs multilínea
que reemplazó al viejo `::set-output::`, deprecado en 2022 por inseguro.

**Consecuencia de la secuencia:** un output no está disponible dentro del mismo step que
lo generó, solo en los siguientes.

Para strings simples, `result-encoding: string` evita el `JSON.parse`.

### 9. GraphQL y Projects v2

`github.graphql(query, variables)` devuelve directamente el objeto `data` — sin el
envoltorio `{ data: ... }` que verías con curl.

#### Node IDs ≠ IDs numéricos

Es el error más frecuente al migrar de REST a GraphQL. En el payload de cualquier evento
conviven ambos:

```json
"id": 1318545360,              ← REST
"node_id": "R_kgDOTpdn0A"      ← GraphQL
```

```js
// ❌ GraphQL responde: "Could not resolve to a node"
contentId: context.issue.number

// ✅
contentId: context.payload.issue.node_id
```

#### Dos mutations, no una

Projects v2 no permite crear un item con sus campos de una vez:

```js
// 1. Agregar la issue al board → devuelve el itemId
const added = await github.graphql(ADD_ITEM, { projectId, contentId })
const itemId = added.addProjectV2ItemById.item.id

// 2. Escribir el campo Priority en ese item
await github.graphql(SET_PRIORITY, { projectId, itemId, fieldId, optionId })
```

`addProjectV2ItemById` es **idempotente**: si la issue ya está en el board, devuelve el
item existente en vez de duplicar.

#### El `value` es polimórfico

```graphql
value: { singleSelectOptionId: $optionId }   # single select
value: { text: "..." }                       # texto
value: { number: 5 }                         # número
value: { date: "2026-08-03" }                # fecha
```

Es la contraparte de escritura de los fragmentos inline en la query de lectura.

#### Tres IDs para un solo valor

Para setear "Priority = P1" necesitas **project + field + option**. En Projects classic
era un solo `column_id`. Nota la asimetría de los formatos:

| Qué | Formato | Por qué |
|---|---|---|
| Project | `PVT_kwHOAMydqM4BfP7k` | Nodo global del grafo |
| Campo | `PVTSSF_lAHOAMydqM4BfP7kzhZkO7c` | Nodo global (nota: contiene el prefijo del project) |
| Opción | `32e546df` | Valor *dentro* de un campo — solo tiene sentido en ese contexto |

#### `paginate` y `endpoint.merge`

La API devuelve 30 items por página. `github.paginate()` recorre todas y devuelve un
array plano:

```js
const opts = github.rest.issues.listForRepo.endpoint.merge({
  owner, repo, creator: author, state: 'all'
})
const previous = await github.paginate(opts)
const isFirstTimer = previous.length <= 1
```

`.endpoint.merge()` construye la **especificación** de la petición sin ejecutarla — es lo
que `paginate` necesita para saber qué iterar.

El `<= 1` (no `=== 0`) es porque la issue que disparó el workflow ya está creada cuando
el script corre. Y `listForRepo` **incluye pull requests** — un detalle histórico de la
API; si importa distinguirlos, filtra por `!issue.pull_request`.

---

## Hardening

Lo que revisarías en un PR ajeno. Nada de esto está en el módulo original.

### Concurrency

```yaml
concurrency:
  group: triage-${{ github.event.issue.number }}
  cancel-in-progress: false
```

**El problema que resuelve.** Por defecto, Actions ejecuta runs en paralelo sin ninguna
coordinación. Si dos runs procesan la **misma issue** simultáneamente, ambos leen el
mismo estado inicial y ambos escriben: dos comentarios de bienvenida, dos items en el
board. Es una condición de carrera clásica, y ocurre más de lo que parece — al reejecutar
un run mientras otro corre, al editar y reabrir una issue rápido, o cuando la API está
lenta y los runs se solapan.

**Cómo funciona.** `group` es una clave de exclusión mutua: **solo un run por grupo puede
estar activo a la vez**. Si llega un segundo run con el mismo `group`, queda *pending*
hasta que el primero termine.

Lo interesante es que el `group` es una **expresión**, así que tú decides la granularidad:

| `group` | Efecto |
|---|---|
| `triage` (fijo) | Un solo run a la vez en todo el repo — serializa demasiado |
| `triage-${{ github.event.issue.number }}` | Un run por issue; issues distintas en paralelo ✅ |
| `${{ github.workflow }}-${{ github.ref }}` | Un run por rama (típico en CI) |

La granularidad correcta es **la del recurso que estás modificando**. Aquí el recurso es
la issue, así que la clave es su número.

**`cancel-in-progress`: la decisión que importa.**

| Valor | Comportamiento | Cuándo usarlo |
|---|---|---|
| `true` | El run nuevo **cancela** al que está corriendo | CI: compilar el commit viejo es desperdicio |
| `false` | El run nuevo **espera** en cola | Workflows con efectos secundarios |

Aquí va `false` deliberadamente. Este workflow **muta estado externo**: publica
comentarios, aplica labels, crea items en un board. Cancelarlo a mitad de camino deja
inconsistencia — por ejemplo, el comentario publicado pero la label sin aplicar, o el item
en el board sin prioridad.

La regla general:

> **¿El workflow solo produce artefactos que se pueden recalcular?** → `cancel-in-progress: true`
> **¿El workflow modifica algo fuera del runner?** → `cancel-in-progress: false`

**Lo que `concurrency` NO hace.** No es un lock distribuido ni garantiza orden de
ejecución: si tres runs quedan en cola, no hay promesa de que se ejecuten en el orden en
que llegaron. Y ojo con un comportamiento poco intuitivo: **si hay varios runs pendientes
en el mismo grupo, GitHub solo conserva el más reciente y descarta los intermedios**. Para
este bot no es problema (cada run atiende su propio evento), pero en un workflow donde
cada run *debe* ejecutarse, hay que tenerlo presente.

También se puede declarar a nivel de job, no solo de workflow, si solo una parte necesita
serialización.

### Permisos mínimos por job

```yaml
permissions: {}          # nivel raíz: cero por defecto

jobs:
  welcome:
    permissions:         # el job pide solo lo que usa
      contents: read
      issues: write
```

`permissions: {}` significa "ningún permiso". Si mañana alguien agrega un segundo job,
arranca sin nada y tiene que declarar explícitamente lo que necesita. Es lo opuesto al
default permisivo que causa la mayoría de los incidentes.

### Pinning por SHA

`@v9` es un **tag mutable**. Quien controle el repo de la action puede reapuntarlo a otro
commit, y tu workflow ejecutará código distinto sin que cambies una línea.

No es teórico: en marzo de 2025, `tj-actions/changed-files` fue comprometida — el atacante
reescribió los tags hacia un commit malicioso que volcaba los secrets del runner en los
logs. Miles de repos lo ejecutaron. Los que tenían pinning por SHA no se vieron afectados.

```bash
gh api repos/actions/checkout/git/ref/tags/v6 --jq '.object.sha'
gh api repos/actions/github-script/git/ref/tags/v9 --jq '.object.sha'
```

```yaml
- uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8  # v6
```

El comentario permite saber la versión sin resolver el hash.

**La objeción obvia** — ya no recibes parches automáticamente. La respuesta es Dependabot,
que abre PRs actualizando los SHAs:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Inmutabilidad **y** actualizaciones revisadas.

### Retries

```yaml
with:
  retries: 3
  retry-exempt-status-codes: 400, 401, 403, 404, 422
```

La API tiene rate limits y un 502 transitorio no debería tumbar el triage. Los reintentos
usan backoff exponencial. Los códigos exentos son los que no tiene sentido reintentar: un
404 seguirá siendo 404, y un 403 de permisos también — reintentarlos solo alarga el fallo.

### Aislamiento de credenciales

El PAT solo se inyecta en el step que lo necesita:

```yaml
- name: Auto-label by content        # procesa ISSUE_TITLE / ISSUE_BODY
  uses: actions/github-script@v9     # → GITHUB_TOKEN acotado
  env:
    ISSUE_TITLE: ${{ github.event.issue.title }}

- name: Add to project board         # solo habla con GraphQL
  uses: actions/github-script@v9
  with:
    github-token: ${{ secrets.PROJECTS_TOKEN }}   # ← el token amplio, aquí y solo aquí
```

El razonamiento: el PAT classic puede escribir en **todos** los projects — es el credencial
más poderoso del workflow. Los steps que procesan entrada controlada por terceros corren
con el `GITHUB_TOKEN` acotado; el token amplio vive únicamente donde se opera con IDs ya
calculados.

Es el principio de permisos mínimos aplicado a nivel de step.

> Este es, además, **el único caso legítimo del input `github-token:`**. El módulo de
> MS Learn lo presenta como obligatorio siempre; desde hace años la action toma el token
> del workflow por defecto y pasarlo explícitamente solo tiene sentido cuando necesitas
> uno *distinto*.

---

## Recorrido por fases

| Fase | Tema | Hallazgo principal |
|---|---|---|
| 0 | Andamiaje y `context` | `context.repo` viene de una env var; `context.issue.number` del payload |
| 1 | Comentario de bienvenida | El 403 "Resource not accessible by integration" es siempre `permissions` |
| 2 | Plantilla desde archivo | El workspace arranca vacío: `contenido = []` |
| 3 | Auto-etiquetado + `if:` | Demostración práctica de script injection |
| 4 | Script externo + outputs | Dentro del `.js` no existen `github`/`context`/`core` |
| 5 | Projects v2 con GraphQL | Node IDs, dos mutations, y el problema del token |
| 6 | Hardening | Concurrency, pinning por SHA, permisos mínimos, retries |

---

## Anexo: diferencias con el material original

El módulo de MS Learn tiene metadatos actualizados (`ms.date: 2025-05-19`), pero el
contenido técnico es de ~2019. Estos son los puntos que **no funcionan** hoy:

| Módulo original | Estado actual |
|---|---|
| `actions/github-script@0.8.0` | `@v9` (v5 cambió la API, v6/v7/v8 el runtime hasta Node 24) |
| `github.issues.createComment` | `github.rest.issues.createComment` |
| `github.projects.createCard` | **Muerto** — REST de Projects classic sunset en abril 2025 |
| `column_id` | Projects v2 no tiene columnas; tiene campos con node IDs |
| `actions/checkout@v2` | `@v6` (v2 corre en Node 12) |
| Sin bloque `permissions:` | Obligatorio desde 2023 (token read-only por defecto) |
| `github-token` presentado como obligatorio | Opcional; solo para tokens distintos al default |
| Sin `await` en las llamadas | Race condition — la action puede terminar antes |
| Sin mención de script injection | La vulnerabilidad principal de github-script |
| Variables: `github`, `context`, `core`, `io` | + `glob`, `exec`, `getOctokit`, `require` wrapper |

**Un detalle sutil del ejercicio original.** Usa `on: issues: types: [opened]` con
`if: contains(github.event.issue.labels.*.name, 'bug')`. En `opened` el array `labels`
suele venir **vacío**, porque el usuario etiqueta *después* de crear. La condición casi
nunca se cumple. El trigger correcto para "cuando se marca como bug" es
`types: [opened, labeled]`.

**Recomendación:** haz el módulo por los conceptos — el modelo mental de "Octokit
preautenticado dentro del runner" es correcto y valioso — pero no copies el código.
El [README de `actions/github-script`](https://github.com/actions/github-script) está bien
mantenido y cubre patrones que el curso no toca.

---

## Referencias

- [`actions/github-script`](https://github.com/actions/github-script)
- [Octokit rest.js](https://octokit.github.io/rest.js/)
- [Security hardening for GitHub Actions](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GraphQL API: Projects v2](https://docs.github.com/graphql/reference/mutations#addprojectv2itembyid)
- [Sunset Notice — Projects (classic)](https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/)
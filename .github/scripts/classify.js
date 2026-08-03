const RULES = [
    { label: 'bug',           patterns: ['error', 'crash', 'crashea', 'falla', 'no funciona', 'bug'] },
    { label: 'enhancement',   patterns: ['feature', 'sugerencia', 'seria bueno', 'propuesta', 'mejora'] },
    { label: 'question',      patterns: ['como puedo', 'duda', 'pregunta', '?'] },
    { label: 'documentation', patterns: ['docs', 'documentacion', 'readme', 'typo'] }
]

const PRIORITY = {
    bug: 'P1',
    enhancement: 'P3',
    question: 'P3',
    documentation: 'P4'
}

module.exports = async ({ github, context, core }) => {
    const title = process.env.ISSUE_TITLE || ''
    const body = process.env.ISSUE_BODY || ''
    const text = `${title}\n${body}`.toLowerCase()

    const matched = RULES.find(r => r.patterns.some(p => text.includes(p)))
    const label = matched ? matched.label : 'needs-triage'
    const priority = PRIORITY[label] || 'P2'

    core.info(`Clasificado como "${label}" (prioridad ${priority})`)

    await github.rest.issues.addLabels({
        ...context.repo,
        issue_number: context.issue.number,
        labels: [label]
    })

    return { label, priority }
}
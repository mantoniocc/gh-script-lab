const ADD_ITEM = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`

const SET_PRIORITY = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`

module.exports = async ({ github, context, core }) => {
  const projectId = process.env.PROJECT_ID
  const fieldId = process.env.PRIORITY_FIELD_ID
  const options = JSON.parse(process.env.PRIORITY_OPTIONS)
  const priority = process.env.PRIORITY

  const contentId = context.payload.issue.node_id

  core.info(`Agregando issue #${context.issue.number} (${contentId}) al project`)

  const added = await github.graphql(ADD_ITEM, { projectId, contentId })
  const itemId = added.addProjectV2ItemById.item.id

  core.info(`Item creado: ${itemId}`)

  const optionId = options[priority]
  if (!optionId) {
    core.warning(`Prioridad "${priority}" sin opción equivalente en el board`)
    return { itemId, priority: null }
  }

  await github.graphql(SET_PRIORITY, { projectId, itemId, fieldId, optionId })

  core.info(`Prioridad ${priority} asignada`)
  return { itemId, priority }
}
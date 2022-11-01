import { ActionModel } from './action.model'
import {
  ContentEntryDraft,
  ENTRY_EXTENSION,
  ENTRY_FOLDER_NAME,
} from '@contentlab/git-adapter'
import { stringify } from 'yaml'

export class ContentEntriesToActionsConverterService {
  convert(
    contentEntries: ContentEntryDraft[],
    existingIdMap: Map<string, boolean>,
    parentSha: string | undefined,
  ): ActionModel[] {
    const actions: ActionModel[] = []
    contentEntries.forEach((contentEntry) => {
      let operation: string
      if (contentEntry.deletion) {
        operation = 'DELETE'
      } else if (existingIdMap.has(contentEntry.id)) {
        operation = 'UPDATE'
      } else {
        operation = 'CREATE'
      }
      actions.push(
        new ActionModel(
          operation,
          stringify({
            metadata: contentEntry.metadata,
            data: contentEntry.data,
          }),
          `${ENTRY_FOLDER_NAME}/${contentEntry.id}${ENTRY_EXTENSION}`,
          parentSha,
        ),
      )
    })
    return actions
  }
}

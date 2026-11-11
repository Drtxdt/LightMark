import type { Transaction } from '@tiptap/pm/state';
import type { CommandMapRange } from './pendingDocumentCommands';

const ATTRIBUTE_ORIGIN = 'lightmarkAssetAttributeOrigin';

/** Call only at the NodeView's explicit setNodeMarkup boundary, never for generic replacement. */
export function markAssetAttributeTransaction(transaction: Transaction, position: number) {
  const records = transaction.getMeta(ATTRIBUTE_ORIGIN) ?? [];
  return transaction.setMeta(ATTRIBUTE_ORIGIN, [...records, { step: transaction.steps.length - 1, position }]);
}

export function pendingPmCommandMaps(transactions: readonly Transaction[]) {
  return transactions.flatMap(transaction => transaction.mapping.maps.map((map, index) => {
    const origin = (transaction.getMeta(ATTRIBUTE_ORIGIN) as Array<{ step: number; position: number }> | undefined)?.find(record => record.step === index);
    const before = origin && transaction.docs[index]?.nodeAt(origin.position);
    const after = origin && (transaction.docs[index + 1] ?? transaction.doc).nodeAt(origin.position);
    const sameReference = before?.type.name === 'image' && after?.type === before.type && after.nodeSize === before.nodeSize
      && (before.attrs.markdownSrc || before.attrs.src) === (after.attrs.markdownSrc || after.attrs.src);
    const ranges: CommandMapRange[] = [];
    map.forEach((from, to, newFrom, newTo) => ranges.push({ from, to, inserted: newTo - newFrom,
      ...(sameReference && origin && from === origin.position && to === from + before!.nodeSize && newTo - newFrom === to - from ? { attributeOnly: true } : {}),
    }));
    return ranges;
  }));
}

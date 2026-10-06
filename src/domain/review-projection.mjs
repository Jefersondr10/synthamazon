import { getLocalReviews } from './local-reviews.mjs';
import { availableReviewStatuses, statusDefinition } from './review-statuses.mjs';

export function localReviewOptions(reviewed) {
  const options = new Map();
  for (const row of reviewed) {
    const option = options.get(row.review.status) ?? { code: row.review.status, label: row.review.label, color: row.review.color, count: 0 };
    option.count++; options.set(option.code, option);
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Manual review is independent of Amazon status, transport and financial evidence. */
export function projectLocalReviews(db, menu, rows, identity, selected = 'all') {
  if (typeof selected !== 'string' || selected !== 'all' && !statusDefinition(db, selected)) {
    throw Object.assign(new TypeError('Invalid review filter.'), { code: 'INVALID_PARAMETERS' });
  }
  const reviews = getLocalReviews(db, rows.map(row => ({ menu, storeId: row.storeId, entityId: identity(row) })));
  const reviewed = rows.map((row, index) => ({ ...row, review: reviews[index] }));
  return { scopedItems: reviewed, items: reviewed.filter(row => selected === 'all' || row.review.status === selected),
    reviewStatusOptions: localReviewOptions(reviewed),
    reviewStatuses: availableReviewStatuses(db, menu) };
}

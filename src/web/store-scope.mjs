/** Restrict a remote session before invoking any read or mutation. */
export function scopeRepository(repository, storeId) {
  if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeId) || storeId === 'all') throw new TypeError('Invalid store scope.');
  const deny = () => { throw Object.assign(new Error('Store is outside this session.'), { code: 'FORBIDDEN' }); };
  const exact = value => { if (value !== storeId) deny(); };
  const filters = (value = {}) => {
    if (value.storeId !== undefined && value.storeId !== 'all') exact(value.storeId);
    return { ...value, storeId };
  };
  const scoped = {};
  for (const name of ['productCostGroup', 'productSkuList', 'dashboard', 'dashboardTransactions', 'orders', 'productPanel','productSales', 'salesAlerts', 'inventory', 'returns', 'customerReturns', 'safeTCases', 'refundManagement', 'syncRefundManagement']) {
    scoped[name] = (input, ...args) => repository[name](filters(input), ...args);
  }
  for (const name of ['orderDetail', 'refundManagementDetail']) {
    scoped[name] = (id, ...args) => { exact(id); return repository[name](id, ...args); };
  }
  scoped.financialCases = (kind, input) => repository.financialCases(kind, filters(input));
  scoped.financialCaseDetail = (kind, id, caseId) => { exact(id); return repository.financialCaseDetail(kind, id, caseId); };
  for (const name of ['localReview', 'saveLocalReview', 'saveFinancialReview', 'saveSalesAlert', 'productCostLink', 'saveProductCostLink', 'saveProductCostGroup']) {
    scoped[name] = input => { exact(input?.storeId); return repository[name](input); };
  }
  for (const name of ['saveRefundManagement', 'saveReturnedManagement', 'saveFinancialReviews']) {
    scoped[name] = input => {
      if (!Array.isArray(input?.items) || !input.items.length) deny();
      input.items.forEach(item => exact(item.storeId));
      return repository[name](input);
    };
  }
  // Status definitions are shared; order notes, amounts and reviews are store scoped.
  for (const name of ['reviewStatusSettings', 'saveReviewStatus']) scoped[name] = (...args) => repository[name](...args);
  scoped.getBootstrap = () => repository.getBootstrap({ storeId });
  scoped.loadWorkspace = () => repository.loadWorkspace({ storeId });
  return scoped;
}

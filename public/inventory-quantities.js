const quantity = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => {
  if (values.some(value => quantity(value) === null)) return null;
  const total = values.reduce((total,value) => total + BigInt(value),0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
};

// Sum disjoint usable positions. Do not add inbound/reserved on top of Amazon's
// total, or subtract researching twice when it is already outside that total.
export function inventoryQuantities(item) {
  const details=item.inventoryDetails || {}, reserved=details.reservedQuantity || {};
  const available=quantity(details.fulfillableQuantity);
  const incoming=sum([details.inboundWorkingQuantity,details.inboundShippedQuantity,details.inboundReceivingQuantity]);
  const internalMovement=sum([reserved.pendingTransshipmentQuantity,reserved.fcProcessingQuantity]);
  return { amazonTotal:quantity(item.totalQuantity),available,incoming,internalMovement,
    usableQuantity:sum([available,incoming,internalMovement]),
    reservedForOrders:quantity(reserved.pendingCustomerOrderQuantity),
    unfulfillable:quantity(details.unfulfillableQuantity?.totalUnfulfillableQuantity),
    researching:quantity(details.researchingQuantity?.totalResearchingQuantity) };
}

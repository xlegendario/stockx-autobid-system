function normalizeLookup(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAutobidEnabled(fields) {
  const val = normalizeLookup(fields["Merchant StockX Autobid Enabled"]);
  return val === true || val === "1" || val === 1;
}

function getRunner(fields) {
  return normalizeLookup(fields["Merchant StockX Runner Name"]);
}

function needsBid(fields) {
  return fields["Needs StockX Bid"] === 1;
}

function needsRemoval(fields) {
  return fields["Needs StockX Removal"] === 1;
}

function getGroupKey(fields) {
  const runner = getRunner(fields);
  const sku = fields["SKU (Soft)"] || fields["SKU"];
  const size = fields["Size"];

  return `${runner}|${sku}|${size}`;
}

export function buildTask(records, runnerName) {
  // 1. filter relevante records
  const filtered = records.filter((r) => {
    const f = r.fields;

    if (!isAutobidEnabled(f)) return false;

    const runner = getRunner(f);
    if (runner !== runnerName) return false;

    if (!needsBid(f) && !needsRemoval(f)) return false;

    return true;
  });

  if (filtered.length === 0) return null;

  // 2. group by key
  const groups = {};

  for (const record of filtered) {
    const key = getGroupKey(record.fields);

    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }

  // 3. pak eerste groep
  const groupKey = Object.keys(groups)[0];
  const group = groups[groupKey];

  // 4. sorteer op created time (oudste eerst)
  group.sort((a, b) => {
    return new Date(a.createdTime) - new Date(b.createdTime);
  });

  // 5. bepaal actie
  const first = group[0];
  const fields = first.fields;

  const sku = fields["SKU (Soft)"] || fields["SKU"];
  const size = fields["Size"];
  const maxBid = fields["Maximum Buying Price"];

  if (needsRemoval(fields)) {
    return {
      type: "REMOVE",
      recordId: first.id,
      sku,
      size
    };
  }

  if (needsBid(fields)) {
    return {
      type: "PLACE_OR_UPDATE",
      recordId: first.id,
      sku,
      size,
      maxBid
    };
  }

  return null;
}

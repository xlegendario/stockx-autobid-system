function normalizeLookup(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAutobidEnabled(fields) {
  const val = fields["Merchant StockX Autobid Enabled"];

  if (val === undefined || val === null || val === "") return false;

  if (Array.isArray(val)) {
    if (val.length === 0) return false;
    const v = val[0];
    return v === true || v === 1 || v === "1" || v === "true";
  }

  return val === true || val === 1 || val === "1" || val === "true";
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

function getSku(fields) {
  return fields["SKU (Soft)"] || fields["SKU"];
}

function getGroupKey(fields) {
  const runner = getRunner(fields);
  const sku = getSku(fields);
  const size = fields["Size"];

  return `${runner}|${sku}|${size}`;
}

export function debugRecords(records, runnerName) {
  return records.slice(0, 25).map((record) => {
    const f = record.fields;

    const autobidRaw = f["Merchant StockX Autobid Enabled"];
    const runnerRaw = f["Merchant StockX Runner Name"];
    const needsBidValue = f["Needs StockX Bid"];
    const needsRemovalValue = f["Needs StockX Removal"];

    const autobid = isAutobidEnabled(f);
    const runner = getRunner(f);
    const bid = needsBid(f);
    const removal = needsRemoval(f);

    return {
      recordId: record.id,
      orderId: f["Order ID"] || null,
      sku: getSku(f),
      size: f["Size"] || null,
      fulfillmentStatus: f["Fulfillment Status"] || null,
      autobidRaw,
      autobidParsed: autobid,
      runnerRaw,
      runnerParsed: runner,
      requestedRunner: runnerName,
      runnerMatches: runner === runnerName,
      needsBidRaw: needsBidValue,
      needsBidParsed: bid,
      needsRemovalRaw: needsRemovalValue,
      needsRemovalParsed: removal,
      included:
        autobid &&
        runner === runnerName &&
        (bid || removal)
    };
  });
}

export function buildTask(records, runnerName) {
  const filtered = records.filter((r) => {
    const f = r.fields;

    if (!isAutobidEnabled(f)) return false;

    const runner = getRunner(f);
    if (runner !== runnerName) return false;

    if (!needsBid(f) && !needsRemoval(f)) return false;

    return true;
  });

  if (filtered.length === 0) return null;

  const groups = {};

  for (const record of filtered) {
    const key = getGroupKey(record.fields);

    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }

  const groupKey = Object.keys(groups)[0];
  const group = groups[groupKey];

  group.sort((a, b) => {
    return new Date(a.createdTime) - new Date(b.createdTime);
  });

  const first = group[0];
  const fields = first.fields;

  const sku = getSku(fields);
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

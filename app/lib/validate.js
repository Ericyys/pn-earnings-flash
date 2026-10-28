// 格式檢查：依 fact_sheet.schema.json 檢查 AI 交出的 JSON。
// 只實作這份規格用到的 JSON Schema 功能，不需要外部套件，離線也能用。
// 回傳錯誤陣列：[{ path: "cash_flow/capex", message: "不允許的欄位：free_cash_flow_stated" }]

export function validate(schema, data) {
  const errors = [];
  const resolve = (ref) => ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], schema);

  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const typeOk = (v, t) => {
    const actual = typeOf(v);
    if (t === "number") return actual === "number" || actual === "integer";
    return actual === t;
  };

  function check(s, v, path, errs) {
    if (!s) return;
    if (s.$ref) check(resolve(s.$ref), v, path, errs);
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => typeOk(v, t))) { errs.push({ path, message: `型別應為 ${ts.join("／")}，實際是 ${typeOf(v)}` }); return; }
    }
    if ("const" in s && v !== s.const) errs.push({ path, message: `應為 ${JSON.stringify(s.const)}` });
    if (s.enum && !s.enum.includes(v)) errs.push({ path, message: `只能是 ${s.enum.join("、")}，實際是 ${JSON.stringify(v)}` });
    if (typeof v === "string") {
      if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errs.push({ path, message: `格式不符（${s.pattern}）：${v}` });
      if (s.maxLength !== undefined && [...v].length > s.maxLength) errs.push({ path, message: `超過 ${s.maxLength} 字` });
    }
    if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) errs.push({ path, message: `不得小於 ${s.minimum}` });
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errs.push({ path, message: `至少要 ${s.minItems} 項` });
      if (s.items) v.forEach((x, i) => check(s.items, x, `${path}/${i}`, errs));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const r of s.required || []) if (!(r in v)) errs.push({ path, message: `缺少必填欄位：${r}` });
      if (s.properties) {
        for (const [k, sub] of Object.entries(s.properties)) if (k in v) check(sub, v[k], path ? `${path}/${k}` : k, errs);
        if (s.additionalProperties === false) {
          for (const k of Object.keys(v)) if (!(k in s.properties)) errs.push({ path, message: `不允許的欄位：${k}` });
        }
      }
    }
    if (s.anyOf) {
      const ok = s.anyOf.some((sub) => { const e = []; check(sub, v, path, e); return e.length === 0; });
      if (!ok) errs.push({ path, message: `需符合其中一種格式：${s.anyOf.map((x) => JSON.stringify(x.required || x.type || "")).join(" 或 ")}` });
    }
    if (s.if) {
      const e = []; check(s.if, v, path, e);
      if (e.length === 0) { if (s.then) check(s.then, v, path, errs); }
      else if (s.else) check(s.else, v, path, errs);
    }
  }

  check(schema, data, "", errors);
  return errors;
}

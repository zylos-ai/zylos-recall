export function precisionAtK(ranked, relevantSet, k) {
  const top = ranked.slice(0, k);
  if (k <= 0) return 0;
  return top.filter(source => relevantSet.has(source)).length / k;
}

export function recallAtK(ranked, relevantSet, k) {
  if (!relevantSet.size) return 0;
  const top = ranked.slice(0, k);
  return top.filter(source => relevantSet.has(source)).length / relevantSet.size;
}

export function mrr(ranked, relevantSet) {
  for (let index = 0; index < ranked.length; index += 1) {
    if (relevantSet.has(ranked[index])) return 1 / (index + 1);
  }
  return 0;
}

export function ndcgAtK(ranked, gradeMap, k) {
  const dcg = ranked.slice(0, k).reduce((sum, source, index) => (
    sum + gain(gradeMap.get(source) || 0, index)
  ), 0);
  const idealGrades = [...gradeMap.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = idealGrades.reduce((sum, grade, index) => sum + gain(grade, index), 0);
  return idcg ? dcg / idcg : 0;
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gain(grade, index) {
  return (2 ** grade - 1) / Math.log2(index + 2);
}


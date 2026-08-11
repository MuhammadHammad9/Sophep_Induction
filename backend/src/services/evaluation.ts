import type { Tx } from './db'

export async function submitEvaluation(
  tx: Tx,
  interviewId: string,
  staffUserId: string,
  scores: Array<{ criterionId: string; score: number }>,
  remarks: string | null,
  recommendedDepartmentId: string | null
): Promise<{ id: string; raw_score: string } | undefined> {
  const rows = await tx<Array<{ id: string; raw_score: string }>>`
    SELECT id, raw_score FROM fn_submit_evaluation(
      ${interviewId}::uuid,
      ${staffUserId}::uuid,
      ${tx.json(
        scores.map((s) => ({ criterion_id: s.criterionId, score: s.score })),
      )}::jsonb,
      ${remarks},
      ${recommendedDepartmentId}::uuid
    )
  `
  return rows[0]
}

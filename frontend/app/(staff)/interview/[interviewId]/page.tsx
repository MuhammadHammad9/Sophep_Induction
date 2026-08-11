/**
 * Interviewer evaluation route.
 *
 * Loads the applicant, and the rubric PINNED AT INTERVIEW START (E17) — never the currently
 * active rubric. Resolving it fresh here would reintroduce exactly the mid-session split the
 * pinning exists to prevent.
 */

import { notFound, redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff } from '@/lib/auth/session'
import { EvaluationForm, type Criterion, type Applicant } from './EvaluationForm'

export const dynamic = 'force-dynamic'

export default async function InterviewPage({
  params,
}: {
  params: Promise<{ interviewId: string }>
}) {
  const { interviewId } = await params

  const staff = await requireStaff()
  if (!staff) redirect('/staff/sign-in')

  const data = await withContext(staff.context, async (tx) => {
    // RLS restricts this to interviews on the caller's own panel (migration 0017).
    const interviews = await tx<
      Array<{
        applicant_id: string
        rubric_id: string
        started_at: Date
        status: string
        display_id: string
        full_name: string
        phone: string
        answers: Record<string, unknown>
      }>
    >`
      SELECT i.applicant_id, i.rubric_id, i.started_at, i.status,
             a.display_id, a.full_name, a.phone, a.answers
        FROM interviews i
        JOIN applicants a ON a.id = i.applicant_id
       WHERE i.id = ${interviewId}::uuid
    `
    const interview = interviews[0]
    if (!interview) return null

    const criteria = await tx<
      Array<{
        id: string
        code: string
        name: string
        description: string | null
        weight: number
        anchor_min: string
        anchor_max: string
        anchors: Record<string, string>
      }>
    >`
      SELECT id, code, name, description, weight, anchor_min, anchor_max, anchors
        FROM rubric_criteria
       WHERE rubric_id = ${interview.rubric_id}::uuid
       ORDER BY sort_order, name
    `

    const rubrics = await tx<Array<{ scale_min: number; scale_max: number }>>`
      SELECT scale_min, scale_max FROM rubrics WHERE id = ${interview.rubric_id}::uuid
    `

    const preferences = await tx<Array<{ name: string }>>`
      SELECT d.name FROM applicant_preferences ap
        JOIN departments d ON d.id = ap.department_id
       WHERE ap.applicant_id = ${interview.applicant_id}::uuid
       ORDER BY ap.rank
    `

    const config = await tx<Array<{ target: number }>>`
      SELECT coalesce((c.config ->> 'interview_target_minutes')::int, 20) AS target
        FROM cycles c
        JOIN interviews i ON i.cycle_id = c.id
       WHERE i.id = ${interviewId}::uuid
    `

    const interviewer = await tx<Array<{ full_name: string; phone: string | null }>>`
      SELECT full_name, phone FROM users WHERE id = ${staff.userId}::uuid
    `

    return { 
      interview, 
      criteria, 
      rubric: rubrics[0], 
      preferences, 
      target: config[0]?.target ?? 20,
      interviewer: interviewer[0] 
    }
  })

  if (!data?.rubric) notFound()

  const applicant: Applicant = {
    displayId: data.interview.display_id,
    fullName: data.interview.full_name,
    phone: data.interview.phone,
    answers: data.interview.answers ?? {},
    preferences: data.preferences,
  }

  const criteria: Criterion[] = data.criteria.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    weight: c.weight,
    anchorMin: c.anchor_min,
    anchorMax: c.anchor_max,
    anchors: c.anchors ?? {},
  }))

  return (
    <EvaluationForm
      interviewId={interviewId}
      applicant={applicant}
      criteria={criteria}
      scaleMin={data.rubric.scale_min}
      scaleMax={data.rubric.scale_max}
      targetMinutes={data.target}
      startedAt={new Date(data.interview.started_at).toISOString()}
      interviewerName={data.interviewer?.full_name}
      interviewerPhone={data.interviewer?.phone}
    />
  )
}

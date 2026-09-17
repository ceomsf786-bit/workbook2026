import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BUCKET = 'workbook-files'
const MAX_BYTES = 10 * 1024 * 1024
const FINAL_SUBMISSION_ERROR = 'This activity has already been submitted. Resubmission is not allowed.'
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-student-token, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-100) || 'file'
}

function inferMime(name: string) {
  if (/\.pdf$/i.test(name)) return 'application/pdf'
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.webp$/i.test(name)) return 'image/webp'
  if (/\.hei[cf]$/i.test(name)) return 'image/heic'
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  return 'application/octet-stream'
}

async function getStudent(req: Request) {
  const token = req.headers.get('x-student-token')?.trim()
  if (!token || token.length < 20) return null
  const { data, error } = await admin
    .from('students')
    .select('id,name,grade,active')
    .eq('access_token', token)
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data
}

async function canAccessActivity(studentId: string, activityId: string) {
  const { data: activity, error } = await admin
    .from('activities')
    .select('id,workbook_id,workbooks!inner(id,active)')
    .eq('id', activityId)
    .eq('workbooks.active', true)
    .maybeSingle()
  if (error) throw error
  if (!activity) return false
  const { data: assignments, error: ae } = await admin
    .from('workbook_assignments')
    .select('workbook_id,custom_workbook_id')
    .eq('student_id', studentId)
  if (ae) throw ae
  return (assignments || []).some((a: any) => (a.custom_workbook_id || a.workbook_id) === activity.workbook_id)
}

async function signedFile<T extends Record<string, any>>(file: T) {
  if (file.external_url) return { ...file, url: file.external_url }
  if (!file.storage_path) return { ...file, url: null }
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(file.storage_path, 1800)
  if (error) throw error
  return { ...file, url: data.signedUrl }
}

async function hub(student: any) {
  const { data: assignments, error: assErr } = await admin
    .from('workbook_assignments')
    .select('workbook_id,custom_workbook_id')
    .eq('student_id', student.id)
  if (assErr) throw assErr
  const workbookIds = (assignments || []).map((x: any) => x.custom_workbook_id || x.workbook_id)
  if (!workbookIds.length) return { student, workbooks: [] }

  const { data: workbooks, error: wbErr } = await admin
    .from('workbooks')
    .select('id,title,subject,grade,term,description,active,custom_student_id,source_workbook_id')
    .in('id', workbookIds)
    .eq('active', true)
    .order('term')
    .order('subject')
    .order('title')
  if (wbErr) throw wbErr
  const activeBookIds = (workbooks || []).map((x: any) => x.id)
  if (!activeBookIds.length) return { student, workbooks: [] }

  const { data: activities, error: actErr } = await admin
    .from('activities')
    .select('id,workbook_id,unit,title,instructions,total_marks,questions,memo,memo_released,date_loaded,due_date,created_at')
    .in('workbook_id', activeBookIds)
    .order('date_loaded')
    .order('created_at')
  if (actErr) throw actErr
  const activityIds = (activities || []).map((x: any) => x.id)

  let activityFiles: any[] = [], submissions: any[] = [], submissionFiles: any[] = [], correctedFiles: any[] = []
  if (activityIds.length) {
    const [af, sub] = await Promise.all([
      admin.from('activity_files').select('*').in('activity_id', activityIds).order('sort_order'),
      admin.from('submissions').select('*').eq('student_id', student.id).in('activity_id', activityIds),
    ])
    if (af.error) throw af.error
    if (sub.error) throw sub.error
    activityFiles = af.data || []
    submissions = sub.data || []
    const submissionIds = submissions.map((x: any) => x.id)
    if (submissionIds.length) {
      const [sf, cf] = await Promise.all([
        admin.from('submission_files').select('*').in('submission_id', submissionIds).order('page_order'),
        admin.from('corrected_files').select('*').in('submission_id', submissionIds).order('created_at'),
      ])
      if (sf.error) throw sf.error
      if (cf.error) throw cf.error
      submissionFiles = sf.data || []
      correctedFiles = cf.data || []
    }
  }

  const signedActivityFiles = await Promise.all(activityFiles.map(signedFile))
  const signedSubmissionFiles = await Promise.all(submissionFiles.map(signedFile))
  const signedCorrectedFiles = await Promise.all(correctedFiles.map(signedFile))

  const books = (workbooks || []).map((w: any) => ({
    ...w,
    personalized: !!w.custom_student_id,
    activities: (activities || []).filter((a: any) => a.workbook_id === w.id).map((a: any) => {
      const sub = submissions.find((x: any) => x.activity_id === a.id && x.finalized_at)
      const questionFiles = signedActivityFiles.filter((x: any) => x.activity_id === a.id && x.kind === 'question')
      const memoFiles = a.memo_released ? signedActivityFiles.filter((x: any) => x.activity_id === a.id && x.kind === 'memo') : []
      return {
        ...a,
        memo: a.memo_released ? a.memo : [],
        question_files: questionFiles,
        memo_files: memoFiles,
        submission: sub ? {
          id: sub.id,
          submitted_at: sub.submitted_at,
          status: sub.status,
          score: sub.score,
          teacher_comment: sub.teacher_comment,
          typed_answers: Array.isArray(sub.typed_answers) ? sub.typed_answers : [],
          files: signedSubmissionFiles.filter((x: any) => x.submission_id === sub.id),
          corrected_files: signedCorrectedFiles.filter((x: any) => x.submission_id === sub.id),
        } : null,
      }
    }),
  }))
  return { student, workbooks: books }
}

async function upload(student: any, req: Request) {
  const form = await req.formData()
  const activityId = String(form.get('activity_id') || '')
  const file = form.get('file')
  if (!activityId || !(file instanceof File)) return json({ error: 'Activity and file are required.' }, 400)
  if (!(await canAccessActivity(student.id, activityId))) return json({ error: 'This activity is not assigned to this learner.' }, 403)
  if (file.size > MAX_BYTES) return json({ error: 'File is larger than 10 MB.' }, 413)
  const mime = file.type || inferMime(file.name)
  const allowed = mime.startsWith('image/') || mime === 'application/pdf'
  if (!allowed) return json({ error: 'Only images and PDF files are allowed.' }, 415)

  const now = new Date().toISOString()
  const existing = await admin.from('submissions').select('id,finalized_at').eq('student_id', student.id).eq('activity_id', activityId).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.finalized_at) return json({ error: FINAL_SUBMISSION_ERROR }, 409)
  let submission = existing.data
  if (!submission) {
    const ins = await admin.from('submissions').insert({
      student_id: student.id,
      activity_id: activityId,
      submitted_at: now,
      status: 'submitted',
      finalized_at: null,
    }).select('id,finalized_at').single()
    if (ins.error) {
      if (ins.error.code === '23505') return json({ error: FINAL_SUBMISSION_ERROR }, 409)
      throw ins.error
    }
    submission = ins.data
  }

  const last = await admin.from('submission_files').select('page_order').eq('submission_id', submission.id).order('page_order', { ascending: false }).limit(1).maybeSingle()
  if (last.error) throw last.error
  const pageOrder = (last.data?.page_order || 0) + 1
  const path = `student-submission/${student.id}/${activityId}/${crypto.randomUUID()}_${safeName(file.name)}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const stored = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false })
  if (stored.error) throw stored.error
  const rec = await admin.from('submission_files').insert({ submission_id: submission.id, storage_path: path, file_name: file.name, mime_type: mime, page_order: pageOrder })
  if (rec.error) {
    await admin.storage.from(BUCKET).remove([path])
    throw rec.error
  }
  return json({ ok: true, submission_id: submission.id, page_order: pageOrder })
}

async function submit(student: any, req: Request) {
  const payload = await req.json().catch(() => ({}))
  const activityId = String(payload.activity_id || '')
  if (!activityId) return json({ error: 'Activity is required.' }, 400)
  if (!(await canAccessActivity(student.id, activityId))) return json({ error: 'This activity is not assigned to this learner.' }, 403)

  const rawAnswers = Array.isArray(payload.typed_answers) ? payload.typed_answers : []
  const typedAnswers = rawAnswers.slice(0, 250).map((x: unknown) => String(x ?? '').slice(0, 12000))
  const hasTypedAnswers = typedAnswers.some((x: string) => x.trim().length > 0)
  const now = new Date().toISOString()

  const { data: existing, error } = await admin
    .from('submissions')
    .select('id,finalized_at')
    .eq('student_id', student.id)
    .eq('activity_id', activityId)
    .maybeSingle()
  if (error) throw error
  if (existing?.finalized_at) return json({ error: FINAL_SUBMISSION_ERROR }, 409)

  let submissionId = existing?.id as string | undefined
  if (!submissionId) {
    if (!hasTypedAnswers) return json({ error: 'Type at least one answer or upload a page before submitting.' }, 400)
    const ins = await admin.from('submissions').insert({
      student_id: student.id,
      activity_id: activityId,
      submitted_at: now,
      status: 'submitted',
      typed_answers: typedAnswers,
      finalized_at: null,
    }).select('id').single()
    if (ins.error) {
      if (ins.error.code === '23505') return json({ error: FINAL_SUBMISSION_ERROR }, 409)
      throw ins.error
    }
    submissionId = ins.data.id
  }

  const { count, error: countErr } = await admin
    .from('submission_files')
    .select('*', { count: 'exact', head: true })
    .eq('submission_id', submissionId)
  if (countErr) throw countErr
  if (!count && !hasTypedAnswers) return json({ error: 'Type at least one answer or upload a page before submitting.' }, 400)

  const { data: finalized, error: upErr } = await admin.from('submissions').update({
    submitted_at: now,
    status: 'submitted',
    typed_answers: typedAnswers,
    score: null,
    teacher_comment: null,
    marked_at: null,
    marked_by: null,
    finalized_at: now,
  }).eq('id', submissionId).is('finalized_at', null).select('id').maybeSingle()
  if (upErr) throw upErr
  if (!finalized) return json({ error: FINAL_SUBMISSION_ERROR }, 409)
  return json({ ok: true, submission_id: submissionId })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  try {
    const student = await getStudent(req)
    if (!student) return json({ error: 'This private learner link is invalid or inactive.' }, 401)
    const action = new URL(req.url).searchParams.get('action') || 'hub'
    if (action === 'hub') return json(await hub(student))
    if (action === 'upload') return await upload(student, req)
    if (action === 'submit') return await submit(student, req)
    return json({ error: 'Unknown action.' }, 404)
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Server error.' }, 500)
  }
})
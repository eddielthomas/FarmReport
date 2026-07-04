// =============================================================================
// email/templates.mjs — registry of named transactional templates.
// -----------------------------------------------------------------------------
// Every email the system sends is composed by one of these factory functions.
// They return an EmailTemplate object that template.mjs renders into HTML+text.
// =============================================================================

import { renderEmail, BRAND } from './template.mjs';

const BASE = process.env.PUBLIC_BASE_URL ?? process.env.APP_ORIGIN ?? 'https://report.farm';

// -----------------------------------------------------------------------------
// 1. Contact form — confirmation to the submitter
// -----------------------------------------------------------------------------
export function contactConfirmation({ first_name, mission_line, message }) {
  return renderEmail({
    subject:   'We received your farm plan request — Report.Farm',
    preheader: `Your ${mission_line.replace('_', ' ')} request is in queue. Response within 5 business days.`,
    eyebrow:   'PLAN REQUEST RECEIVED',
    title:     `Thank you, ${first_name}.`,
    accent:    BRAND.cyan,
    blocks: [
      { kind: 'paragraph', text: 'Your request is in the queue with our farm intelligence desk. We respond to every inbound within 5 business days — usually faster.' },
      { kind: 'kpi', rows: [
        { label: 'Focus area', value: mission_line.replace(/_/g, ' ') },
        { label: 'Status',     value: 'Queued for review' },
        { label: 'SLA',        value: '5 business days' },
      ]},
      { kind: 'heading',   text: 'What happens next' },
      { kind: 'list', items: [
        'A farm lead reviews your context and routes it to the right specialist.',
        'We come back with a scoped Report.Farm plan — fields, signals, cadence, and reports.',
        'If you flagged NDA-required, we send a mutual NDA before continuing.',
      ]},
      { kind: 'panel', text: `Your submission: "${message.slice(0, 280)}${message.length > 280 ? '…' : ''}"` },
      { kind: 'paragraph', text: 'Reply directly to this email for anything urgent. If your situation is active and time-sensitive, the 24/7 farm ops line is ops@report.farm.' },
    ],
    cta: { label: 'See the platform', href: `${BASE}/platform.html` },
    footerNote: 'You received this email because you submitted the contact form on report.farm/contact.html.',
  });
}

// -----------------------------------------------------------------------------
// 2. Contact form — internal notification to the farm desk
// -----------------------------------------------------------------------------
export function contactInternal({ first_name, last_name, email, company, industry, mission_line, message, newsletter, ip, user_agent }) {
  return renderEmail({
    subject:   `[Contact] ${first_name} ${last_name} · ${company} · ${mission_line.replace(/_/g, ' ')}`,
    preheader: `${company} — ${industry} — ${mission_line.replace(/_/g, ' ')}`,
    eyebrow:   'INBOUND',
    title:     `${first_name} ${last_name}`,
    accent:    BRAND.amber,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'Email',        value: email },
        { label: 'Company',      value: company },
        { label: 'Industry',     value: industry },
        { label: 'Focus area',   value: mission_line.replace(/_/g, ' ') },
        { label: 'Newsletter',   value: newsletter ? 'opted in' : 'no' },
      ]},
      { kind: 'heading',   text: 'Message' },
      { kind: 'paragraph', text: message },
      { kind: 'divider' },
      { kind: 'kpi', rows: [
        { label: 'IP',         value: ip ?? '—' },
        { label: 'User agent', value: (user_agent ?? '—').slice(0, 80) },
      ]},
    ],
    cta: { label: `Reply to ${first_name}`, href: `mailto:${email}` },
    footerNote: 'Generated from /contact.html. Persisted to public.contact_submission.',
  });
}

// -----------------------------------------------------------------------------
// 3. Welcome / registration
// -----------------------------------------------------------------------------
export function welcome({ first_name, tenant_name }) {
  return renderEmail({
    subject:   `Welcome to Report.Farm${tenant_name ? ', ' + tenant_name : ''}`,
    preheader: 'Your account is active. Here is how to get the most out of Report.Farm.',
    eyebrow:   'WELCOME',
    title:     `Welcome aboard, ${first_name}.`,
    accent:    BRAND.green,
    blocks: [
      { kind: 'paragraph', text: 'Your Report.Farm account is active. You can now sign in, explore your portfolio map, and start uploading your field boundaries.' },
      { kind: 'heading', text: 'A 90-second orientation' },
      { kind: 'list', items: [
        'The map (left panel) shows live field signals — toggle satellite, crop-stress, and your field-boundary layers.',
        'The right rail surfaces the latest field intel and AI summary for whatever you select.',
        'Upload your field boundaries, crop plans, or parcel maps via the customer portal — we overlay them automatically.',
        'Coach-mark tours fire on first visit — click "Got it" or "Skip" to dismiss; re-open with the help (?) icon.',
      ]},
      { kind: 'panel', text: 'Tip: drop any GeoJSON, Shapefile (.shp.zip), KML, KMZ, or GeoTIFF into the upload card on your portal. We parse + render in seconds.' },
    ],
    cta: { label: 'Open Report.Farm', href: `${BASE}/operations.html` },
    footerNote: 'You can update your notification preferences from your profile.',
  });
}

// -----------------------------------------------------------------------------
// 4. Password reset
// -----------------------------------------------------------------------------
export function passwordReset({ first_name, reset_url, expires_minutes = 30 }) {
  return renderEmail({
    subject:   'Reset your Report.Farm password',
    preheader: `Use the link below to set a new password. It expires in ${expires_minutes} minutes.`,
    eyebrow:   'PASSWORD RESET',
    title:     'Reset your password.',
    accent:    BRAND.amber,
    blocks: [
      { kind: 'paragraph', text: `Hi ${first_name}, we received a request to reset the password on your Report.Farm account.` },
      { kind: 'paragraph', text: `Click the button below to choose a new password. The link is single-use and expires in ${expires_minutes} minutes.` },
      { kind: 'panel', text: "If you didn't request this, you can safely ignore this email — your password won't change." },
    ],
    cta: { label: 'Reset password', href: reset_url },
    footerNote: 'Trouble with the button? Paste the link into your browser address bar.',
  });
}

// -----------------------------------------------------------------------------
// 5. Newsletter subscribe confirmation (double opt-in)
// -----------------------------------------------------------------------------
export function newsletterConfirm({ first_name, confirm_url }) {
  return renderEmail({
    subject:   'Confirm your Report.Farm newsletter subscription',
    preheader: 'One click to confirm — then product updates roughly monthly. No spam.',
    eyebrow:   'CONFIRM SUBSCRIPTION',
    title:     'One last step.',
    accent:    BRAND.cyan,
    blocks: [
      { kind: 'paragraph', text: `Hi${first_name ? ' ' + first_name : ''} — confirm your subscription so we can start sending you product updates.` },
      { kind: 'panel', text: "We send roughly one email a month. No spam. Unsubscribe any time with a single click." },
    ],
    cta: { label: 'Confirm subscription', href: confirm_url },
    footerNote: 'If you didn’t sign up, you can ignore this and we won’t add you to the list.',
  });
}

// -----------------------------------------------------------------------------
// 6. Lead status change (internal — sales notification)
// -----------------------------------------------------------------------------
export function leadStatusChanged({ lead_name, from_status, to_status, by_user, note }) {
  return renderEmail({
    subject:   `Lead ${lead_name}: ${from_status} → ${to_status}`,
    preheader: `${by_user} moved ${lead_name} to ${to_status}.`,
    eyebrow:   'LEAD UPDATED',
    title:     `${lead_name}`,
    accent:    BRAND.blue,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'From',  value: from_status },
        { label: 'To',    value: to_status },
        { label: 'By',    value: by_user },
      ]},
      ...(note ? [{ kind: 'panel', text: note }] : []),
    ],
    cta: { label: 'Open in Sales', href: `${BASE}/sales.html` },
  });
}

// -----------------------------------------------------------------------------
// 7. Case assigned (internal — ops notification)
// -----------------------------------------------------------------------------
export function caseAssigned({ case_title, assignee_name, priority, by_user, case_id }) {
  return renderEmail({
    subject:   `[${priority?.toUpperCase()}] Case assigned: ${case_title}`,
    preheader: `${by_user} assigned you ${case_title}.`,
    eyebrow:   'CASE ASSIGNED',
    title:     case_title,
    accent:    priority === 'high' || priority === 'critical' ? BRAND.red : BRAND.amber,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'Assignee', value: assignee_name },
        { label: 'Priority', value: priority },
        { label: 'By',       value: by_user },
      ]},
      { kind: 'paragraph', text: 'Open the case to see the detection, activity log, and any attached intel.' },
    ],
    cta: { label: 'Open case', href: `${BASE}/pm.html#case-${case_id}` },
  });
}

// -----------------------------------------------------------------------------
// 8. Lead created (internal — sales pickup notification)  [S3B]
// -----------------------------------------------------------------------------
export function leadCreated({ lead_name, lead_company, lead_status, lead_source, by_user, lead_id }) {
  return renderEmail({
    subject:   `New lead: ${lead_name}${lead_company ? ' (' + lead_company + ')' : ''}`,
    preheader: `${by_user} created a new ${lead_status} lead.`,
    eyebrow:   'NEW LEAD',
    title:     lead_name,
    accent:    BRAND.cyan,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'Company', value: lead_company ?? '-' },
        { label: 'Status',  value: lead_status  ?? 'Info Request' },
        { label: 'Source',  value: lead_source  ?? 'Unknown' },
        { label: 'By',      value: by_user      ?? 'system' },
      ]},
      { kind: 'paragraph', text: 'Pick this lead up in the Sales workspace to assign an owner and start working it.' },
    ],
    cta: { label: 'Open in Sales', href: `${BASE}/sales.html#lead-${lead_id}` },
  });
}

// -----------------------------------------------------------------------------
// 9. Meeting scheduled (internal — attendee/owner notification)  [S3B]
// -----------------------------------------------------------------------------
export function meetingScheduled({ title, start_at, end_at, location, notes, by_user, meeting_id }) {
  const startTxt = start_at ? new Date(start_at).toUTCString() : '-';
  const endTxt   = end_at   ? new Date(end_at).toUTCString()   : '-';
  return renderEmail({
    subject:   `Meeting scheduled: ${title}`,
    preheader: `${by_user} scheduled ${title} on ${startTxt}.`,
    eyebrow:   'MEETING SCHEDULED',
    title,
    accent:    BRAND.blue,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'Starts',   value: startTxt },
        { label: 'Ends',     value: endTxt },
        { label: 'Location', value: location ?? '-' },
        { label: 'By',       value: by_user  ?? 'system' },
      ]},
      ...(notes ? [{ kind: 'panel', text: notes }] : []),
    ],
    cta: { label: 'Open calendar', href: `${BASE}/calendar.html#meeting-${meeting_id}` },
  });
}

// -----------------------------------------------------------------------------
// 10. Chat alert (internal — escalation from the conversation thread)  [S3B]
// -----------------------------------------------------------------------------
export function chatAlert({ conversation_id, conversation_subject, message_excerpt, by_user }) {
  return renderEmail({
    subject:   `Chat alert: ${conversation_subject}`,
    preheader: `${by_user} flagged ${conversation_subject} for review.`,
    eyebrow:   'CHAT ALERT',
    title:     conversation_subject,
    accent:    BRAND.amber,
    blocks: [
      { kind: 'kpi', rows: [
        { label: 'Flagged by', value: by_user ?? 'system' },
      ]},
      ...(message_excerpt ? [{ kind: 'panel', text: message_excerpt }] : []),
      { kind: 'paragraph', text: 'Open the conversation to review the full thread and respond.' },
    ],
    cta: { label: 'Open conversation', href: `${BASE}/messages.html#convo-${conversation_id}` },
  });
}

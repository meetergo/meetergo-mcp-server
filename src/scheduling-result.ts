type SchedulingResultKind =
  | 'availability'
  | 'appointment'
  | 'appointment-list'
  | 'today-appointments'
  | 'book'
  | 'reschedule'
  | 'cancel'

interface SchedulingResultContext {
  requestedStart?: string
  attendeeId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isoUtc(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Persisted appointments are either confirmed or cancelled. Pending
 * confirmations have no appointment yet and are handled by the booking result.
 */
function decorateAppointment(appointment: unknown): unknown {
  if (!isRecord(appointment)) return appointment

  const cancelled =
    appointment['isCancelled'] === true ||
    (isRecord(appointment['cancel']) &&
      appointment['cancel']['actionAt'] != null)
  const rescheduled =
    appointment['rescheduledAt'] != null ||
    (typeof appointment['rescheduleCount'] === 'number' &&
      appointment['rescheduleCount'] > 0)

  return {
    ...appointment,
    status: cancelled ? 'cancelled' : 'confirmed',
    ...(rescheduled ? { rescheduled: true } : {}),
  }
}

function presentAvailability(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload['dates'])) return payload

  const starts = new Set<string>()
  for (const day of payload['dates']) {
    if (!isRecord(day) || !Array.isArray(day['spots'])) continue
    for (const spot of day['spots']) {
      if (!isRecord(spot)) continue
      const start = isoUtc(spot['startTime'])
      if (start !== undefined) starts.add(start)
    }
  }

  return { ...payload, slotsStartUtc: [...starts].sort() }
}

function presentAppointmentList(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload['appointments'])) {
    return payload
  }
  return {
    ...payload,
    appointments: payload['appointments'].map(decorateAppointment),
  }
}

function presentTodaysAppointments(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(decorateAppointment)
  return presentAppointmentList(payload)
}

function pendingBookingMessage(bookingType: unknown): string {
  if (bookingType === 'doubleOptIn') {
    return 'NOT booked yet. The attendee must confirm by email before the appointment exists.'
  }
  return 'NOT booked yet. The host must confirm before the appointment exists.'
}

function presentBooking(
  payload: unknown,
  context: SchedulingResultContext,
): unknown {
  if (!isRecord(payload)) return payload

  if (
    payload['provisionalBookingId'] != null ||
    typeof payload['bookingType'] === 'string'
  ) {
    return {
      ...payload,
      bookingState: 'pending_confirmation',
      message: pendingBookingMessage(payload['bookingType']),
    }
  }

  const startUtc = isoUtc(context.requestedStart ?? payload['start'])
  return {
    ...payload,
    bookingState: 'confirmed',
    ...(startUtc === undefined ? {} : { startUtc }),
  }
}

function presentReschedule(
  payload: unknown,
  context: SchedulingResultContext,
): unknown {
  if (!isRecord(payload)) return payload

  const appointment = decorateAppointment(payload['appointment'])
  const nestedStart = isRecord(payload['appointment'])
    ? payload['appointment']['start']
    : undefined
  const startUtc = isoUtc(
    context.requestedStart ?? nestedStart ?? payload['start'],
  )

  return {
    ...payload,
    ...(payload['appointment'] === undefined ? {} : { appointment }),
    bookingState: 'confirmed',
    ...(startUtc === undefined ? {} : { startUtc }),
  }
}

function presentCancellation(
  payload: unknown,
  context: SchedulingResultContext,
): unknown {
  if (!isRecord(payload)) return payload

  const appointment = decorateAppointment(payload) as Record<string, unknown>
  if (context.attendeeId !== undefined) {
    return {
      ...appointment,
      bookingState: 'attendee_removed',
      removedAttendeeId: context.attendeeId,
    }
  }

  return {
    ...appointment,
    status: 'cancelled',
    bookingState: 'cancelled',
  }
}

/**
 * Presents scheduling API payloads in states an agent can use directly while
 * preserving every original response field.
 */
export function presentSchedulingResult(
  kind: SchedulingResultKind,
  payload: unknown,
  context: SchedulingResultContext = {},
): unknown {
  switch (kind) {
    case 'availability':
      return presentAvailability(payload)
    case 'appointment':
      return decorateAppointment(payload)
    case 'appointment-list':
      return presentAppointmentList(payload)
    case 'today-appointments':
      return presentTodaysAppointments(payload)
    case 'book':
      return presentBooking(payload, context)
    case 'reschedule':
      return presentReschedule(payload, context)
    case 'cancel':
      return presentCancellation(payload, context)
  }
}

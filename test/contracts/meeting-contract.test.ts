import {
  cancelMeetingRequestSchema,
  concludeMeetingRequestSchema,
  createMeetingRequestSchema,
  meetingViewSchema,
  postTurnRequestSchema,
} from "@opc/contracts";
import { describe, expect, it } from "vitest";

describe("meeting contracts", () => {
  it("creates a decision meeting with a moderator-only default speaking order", () => {
    expect(
      createMeetingRequestSchema.parse({
        group_id: "g-1",
        topic: "  Launch decision  ",
        moderator_member_id: "m-1",
      }),
    ).toEqual({
      group_id: "g-1",
      topic: "Launch decision",
      moderator_member_id: "m-1",
      meeting_type: "decision",
    });
  });

  it("accepts an explicit next speaker, leaves participant validity to the service, and rejects unknown fields", () => {
    expect(
      postTurnRequestSchema.parse({
        speaker_member_id: "m-1",
        content: "  My turn  ",
        next_speaker_member_id: "m-2",
      }),
    ).toEqual({
      speaker_member_id: "m-1",
      content: "My turn",
      next_speaker_member_id: "m-2",
    });
    expect(
      postTurnRequestSchema.safeParse({
        speaker_member_id: "m-1",
        content: "My turn",
        next_speaker_member_id: "m-1",
      }).success,
    ).toBe(true); // Participant validity is a service/DB concern, not a schema concern.
    expect(
      postTurnRequestSchema.safeParse({
        speaker_member_id: "m-1",
        content: "My turn",
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it("requires all three conclusion fields and a nonempty cancellation reason", () => {
    const conclusion = {
      decision: "Ship",
      owner_member_id: "m-2",
      deadline_at: 1_800_000_000_000,
    };
    expect(concludeMeetingRequestSchema.parse(conclusion)).toEqual(conclusion);
    for (const key of Object.keys(conclusion)) {
      const incomplete: Record<string, unknown> = { ...conclusion };
      delete incomplete[key];
      expect(concludeMeetingRequestSchema.safeParse(incomplete).success).toBe(
        false,
      );
    }
    expect(
      cancelMeetingRequestSchema.parse({ reason: "  Waiting on data  " }),
    ).toEqual({
      reason: "Waiting on data",
    });
    expect(cancelMeetingRequestSchema.safeParse({ reason: " " }).success).toBe(
      false,
    );
  });

  it("makes the persisted next speaker explicit in the meeting view", () => {
    const view = {
      meeting_id: "meeting-1",
      group_id: "g-1",
      task_id: null,
      meeting_type: "decision",
      topic: "Launch",
      moderator_member_id: "m-1",
      speaking_order: ["m-1", "m-2"],
      status: "open",
      decision: null,
      owner_member_id: null,
      deadline_at: null,
      summary_doc_id: null,
      next_speaker_member_id: "m-1",
      turns: [],
      opened_at: 100,
      concluded_at: null,
    };
    expect(meetingViewSchema.parse(view)).toEqual(view);
    const { next_speaker_member_id: _missing, ...withoutNext } = view;
    expect(meetingViewSchema.safeParse(withoutNext).success).toBe(false);
  });
});

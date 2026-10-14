# Facilitator assignment sheet

Keep this sheet with the facilitator. Give each participant one assignment row and only the link for the task currently underway. Serve the `research/` directory over HTTP so the inspector can load its saved reports and screenshots. The links below are relative to that directory.

| Assignment | First 7-minute task | Second 7-minute task |
| --- | --- | --- |
| 1 | A, player view: `equipment-author-inspector.html?study=A&view=player` | B, author audit: `equipment-author-inspector.html?study=B&view=audit` |
| 2 | A, author audit: `equipment-author-inspector.html?study=A&view=audit` | B, player view: `equipment-author-inspector.html?study=B&view=player` |
| 3 | B, player view: `equipment-author-inspector.html?study=B&view=player` | A, author audit: `equipment-author-inspector.html?study=A&view=audit` |
| 4 | B, author audit: `equipment-author-inspector.html?study=B&view=audit` | A, player view: `equipment-author-inspector.html?study=A&view=player` |

Read the same instruction before each task: “The level promises that this fact first becomes available after the named inspection. Examine the available player history and identify whether anything reveals it earlier. State the earliest action, the channel where it appears, and one repair that preserves the intended inspection.” For Task A, name `Inspect fuse` as the intended reveal. For Task B, name `Measure voltage` as the intended reveal. Do not describe the seeded fault. Give the participant the [response sheet](equipment-author-study-response.md) and start a seven-minute timer when the task link opens. Keep the [answer key](equipment-author-study-answer-key.md) private until all responses are submitted.

The link parameters set a neutral task ID and a locked view. They are not access controls; if a participant changes the URL or opens the general inspector, record that deviation. Do not analyze those responses as assigned-condition observations without noting it.

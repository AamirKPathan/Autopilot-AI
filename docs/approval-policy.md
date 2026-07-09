# Approval Policy

## Automatic

These actions can usually run without a prompt:

- Reading local files
- Listing directories
- Drafting notes
- Creating local artifacts
- Checking configuration
- Summarizing logs
- Inspecting emulator screenshots or device state

## Require approval

These actions should stop and ask first:

- Sending email or messages
- Posting publicly
- Making purchases
- Deleting important files
- Changing account settings
- Touching billing or payment data
- Modifying business records
- Any action with external side effects that the user did not explicitly request

## Principle

If the action is hard to undo, has external side effects, or can affect money or data integrity, require approval.
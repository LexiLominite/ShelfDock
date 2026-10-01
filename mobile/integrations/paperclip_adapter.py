"""Explicit Paperclip tool adapter. No subscriptions, hooks, or automatic sending."""
from notify import send_notification, get_notification_status


def send_phone_notification(*, title, body, severity="info", device_id=None, event_id=None, config_path=None):
    """Call only when a human authorized this alert or a specific completion alert."""
    return send_notification(title, body, source="paperclip", severity=severity,
                             device=device_id, event_id=event_id, config_path=config_path)


def get_phone_notification_status(notification_id, *, config_path=None):
    return get_notification_status(notification_id, config_path=config_path)

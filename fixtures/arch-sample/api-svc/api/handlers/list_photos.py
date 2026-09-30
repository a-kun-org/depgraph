from domain.models import Photo


def handle_list(event, context):
    return {"items": [Photo(id="1").to_dict()]}

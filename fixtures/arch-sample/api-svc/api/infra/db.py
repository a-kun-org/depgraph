from domain.models import Photo


def load_photo(photo_id: str) -> Photo:
    return Photo(id=photo_id)

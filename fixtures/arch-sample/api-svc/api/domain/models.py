class Photo:
    def __init__(self, id: str):
        self.id = id

    def to_dict(self):
        return {"id": self.id}

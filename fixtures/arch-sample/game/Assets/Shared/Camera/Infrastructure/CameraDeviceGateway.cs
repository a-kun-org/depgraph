using Game.Camera.Domain;

namespace Game.Camera.Infrastructure
{
    public class CameraDeviceGateway
    {
        public CameraPose Read()
        {
            return new CameraPose();
        }
    }
}

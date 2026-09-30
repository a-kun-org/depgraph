using Game.Camera.Application;

namespace Game.Camera.Presentation
{
    public class CameraHudView
    {
        private CameraService _service;

        public void Bind(CameraService service)
        {
            _service = service;
        }
    }
}

namespace Vsnap.Camera
{
    public class CameraController
    {
        private CameraPose _pose;
        private LightRig _light;

        public void Bind(CameraPose pose, LightRig light)
        {
            _pose = pose;
            _light = light;
        }
    }
}

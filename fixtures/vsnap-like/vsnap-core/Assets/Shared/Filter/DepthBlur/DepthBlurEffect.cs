namespace Vsnap.Filter
{
    public class DepthBlurEffect
    {
        private CameraController _camera;

        public void Attach(CameraController camera)
        {
            _camera = camera;
        }
    }
}

namespace Vsnap.Colocation
{
    public class ColocationSession
    {
        private VpsClient _vps;
        private CardView _card;

        public void Start(VpsClient vps, CardView card)
        {
            _vps = vps;
            _card = card;
        }
    }
}
